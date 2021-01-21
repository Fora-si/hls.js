/**
 * @author Stephan Hesse <disparat@gmail.com> | <tchakabam@gmail.com>
 *
 * DRM support for Hls.js
 */
import { Events } from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';

import { logger } from '../utils/logger';
import type { DRMSystemOptions, EMEControllerConfig } from '../config';
import type { MediaKeyFunc } from '../utils/mediakeys-helper';
import {
  base64ToUint8Array,
  buildPlayReadyPSSHBox,
  makePlayreadyHeaders,
} from '../utils/eme-helper';
import {
  KeySystems,
  DRMIdentifiers,
  InitDataTypes,
} from '../utils/mediakeys-helper';
import type Hls from '../hls';
import type { ComponentAPI } from '../types/component-api';
import type {
  MediaAttachedData,
  ManifestParsedData,
  FragLoadedData,
} from '../types/events';

const MAX_LICENSE_REQUEST_FAILURES = 3;

/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemConfiguration
 * @param {Array<string>} audioCodecs List of required audio codecs to support
 * @param {Array<string>} videoCodecs List of required video codecs to support
 * @param {object} drmSystemOptions Optional parameters/requirements for the key-system
 * @returns {Array<MediaSystemConfiguration>} An array of supported configurations
 */

const createWidevineMediaKeySystemConfigurations = function (
  audioCodecs: string[],
  videoCodecs: string[],
  drmSystemOptions: DRMSystemOptions
): MediaKeySystemConfiguration[] {
  /* jshint ignore:line */
  const baseConfig: MediaKeySystemConfiguration = {
    // initDataTypes: ['keyids', 'mp4'],
    // label: "",
    // persistentState: "not-allowed", // or "required" ?
    // distinctiveIdentifier: "not-allowed", // or "required" ?
    // sessionTypes: ['temporary'],
    audioCapabilities: [], // { contentType: 'audio/mp4; codecs="mp4a.40.2"' }
    videoCapabilities: [], // { contentType: 'video/mp4; codecs="avc1.42E01E"' }
  };

  audioCodecs.forEach((codec) => {
    baseConfig.audioCapabilities!.push({
      contentType: `audio/mp4; codecs="${codec}"`,
      robustness: drmSystemOptions.audioRobustness || '',
    });
  });
  videoCodecs.forEach((codec) => {
    baseConfig.videoCapabilities!.push({
      contentType: `video/mp4; codecs="${codec}"`,
      robustness: drmSystemOptions.videoRobustness || '',
    });
  });

  return [baseConfig];
};

/**
 * The idea here is to handle key-system (and their respective platforms) specific configuration differences
 * in order to work with the local requestMediaKeySystemAccess method.
 *
 * We can also rule-out platform-related key-system support at this point by throwing an error.
 *
 * @param {string} keySystem Identifier for the key-system, see `KeySystems` enum
 * @param {Array<string>} audioCodecs List of required audio codecs to support
 * @param {Array<string>} videoCodecs List of required video codecs to support
 * @throws will throw an error if a unknown key system is passed
 * @returns {Array<MediaSystemConfiguration>} A non-empty Array of MediaKeySystemConfiguration objects
 */
const getSupportedMediaKeySystemConfigurations = function (
  keySystem: KeySystems,
  audioCodecs: string[],
  videoCodecs: string[],
  drmSystemOptions: DRMSystemOptions
): MediaKeySystemConfiguration[] {
  switch (keySystem) {
    case KeySystems.WIDEVINE:
    case KeySystems.PLAYREADY:
      return createWidevineMediaKeySystemConfigurations(
        audioCodecs,
        videoCodecs,
        drmSystemOptions
      );
    default:
      throw new Error(`Unknown key-system: ${keySystem}`);
  }
};

interface MediaKeysListItem {
  mediaKeys?: MediaKeys;
  mediaKeysSession?: MediaKeySession;
  mediaKeysSessionInitialized: boolean;
  mediaKeySystemAccess: MediaKeySystemAccess;
  mediaKeySystemDomain: KeySystems;
}

/**
 * Controller to deal with encrypted media extensions (EME)
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Encrypted_Media_Extensions_API
 *
 * @class
 * @constructor
 */
class EMEController implements ComponentAPI {
  private hls: Hls;
  private _widevineLicenseUrl?: string;
  private _playreadyLicenseUrl?: string;
  private _licenseXhrSetup?: (xhr: XMLHttpRequest, url: string) => void;
  private _licenseResponseCallback?: (
    xhr: XMLHttpRequest,
    url: string
  ) => ArrayBuffer;
  private _selectedDrm?: string;
  private _requestMediaKeySystemAccess: MediaKeyFunc | null;
  private _drmSystemOptions: DRMSystemOptions;

  private _config: EMEControllerConfig;
  private _mediaKeysList: MediaKeysListItem[] = [];
  private _mediaKeys?: MediaKeys;
  private _media: HTMLMediaElement | null = null;
  private _hasSetMediaKeys: boolean = false;
  private _haveKeySession: boolean = false;
  private _requestLicenseFailureCount: number = 0;

  private _currentPssh?: string | null = null;
  private _keySystemPssh?: string | null = null;

  private _initDataType?: string;
  private _initData?: ArrayBuffer | null;

  private _audioCodecs: string[] = [];
  private _videoCodecs: string[] = [];

  private mediaKeysPromise: Promise<MediaKeys> | null = null;
  private _onMediaEncrypted = this.onMediaEncrypted.bind(this);

  /**
   * @constructs
   * @param {Hls} hls Our Hls.js instance
   */
  constructor(hls: Hls) {
    this.hls = hls;
    this._config = hls.config;

    this._widevineLicenseUrl = this._config.widevineLicenseUrl;
    this._playreadyLicenseUrl = this._config.playreadyLicenseUrl;
    this._licenseXhrSetup = this._config.licenseXhrSetup;
    this._licenseResponseCallback = this._config.licenseResponseCallback;
    this._selectedDrm = this._config.drmSystem;
    this._requestMediaKeySystemAccess = this._config.requestMediaKeySystemAccessFunc;
    this._drmSystemOptions = this._config.drmSystemOptions;

    this._registerListeners();
  }

  public destroy() {
    this._unregisterListeners();
    // @ts-ignore
    this.hls = this._onMediaEncrypted = null;
    this._requestMediaKeySystemAccess = null;
  }

  private _registerListeners() {
    this.hls.on(Events.MEDIA_ATTACHED, this.onMediaAttached, this);
    this.hls.on(Events.MEDIA_DETACHED, this.onMediaDetached, this);
    this.hls.on(Events.MANIFEST_PARSED, this.onManifestParsed, this);
    this.hls.on(Events.FRAG_LOADED, this.onFragLoaded, this);
  }

  private _unregisterListeners() {
    this.hls.off(Events.MEDIA_ATTACHED, this.onMediaAttached, this);
    this.hls.off(Events.MEDIA_DETACHED, this.onMediaDetached, this);
    this.hls.off(Events.MANIFEST_PARSED, this.onManifestParsed, this);
    this.hls.off(Events.FRAG_LOADED, this.onFragLoaded, this);
  }

  /**
   * @param {string} keySystem Identifier for the key-system, see `KeySystems` enum
   * @returns {string} License server URL for key-system (if any configured, otherwise causes error)
   * @throws if a unsupported keysystem is passed
   */
  getLicenseServerUrl(keySystem: KeySystems): string {
    switch (keySystem) {
      case KeySystems.WIDEVINE:
        if (!this._widevineLicenseUrl) {
          break;
        }
        return this._widevineLicenseUrl;
      case KeySystems.PLAYREADY:
        if (!this._playreadyLicenseUrl) {
          break;
        }
        return this._playreadyLicenseUrl;
    }

    throw new Error(
      `no license server URL configured for key-system "${keySystem}"`
    );
  }

  /**
   * Requests access object and adds it to our list upon success
   * @private
   * @param {string} keySystem System ID (see `KeySystems`)
   * @param {Array<string>} audioCodecs List of required audio codecs to support
   * @param {Array<string>} videoCodecs List of required video codecs to support
   * @throws When a unsupported KeySystem is passed
   */
  private _attemptKeySystemAccess(
    keySystem: KeySystems,
    audioCodecs: string[],
    videoCodecs: string[]
  ) {
    // This can throw, but is caught in event handler callpath
    const mediaKeySystemConfigs = getSupportedMediaKeySystemConfigurations(
      keySystem,
      audioCodecs,
      videoCodecs,
      this._drmSystemOptions
    );

    logger.log('Requesting encrypted media key-system access');

    // expecting interface like window.navigator.requestMediaKeySystemAccess
    const keySystemAccessPromise = this.requestMediaKeySystemAccess(
      keySystem,
      mediaKeySystemConfigs
    );

    this.mediaKeysPromise = keySystemAccessPromise.then(
      (mediaKeySystemAccess) =>
        this._onMediaKeySystemAccessObtained(keySystem, mediaKeySystemAccess)
    );

    keySystemAccessPromise.catch((err) => {
      logger.error(`Failed to obtain key-system "${keySystem}" access:`, err);
    });
  }

  get requestMediaKeySystemAccess() {
    if (!this._requestMediaKeySystemAccess) {
      throw new Error('No requestMediaKeySystemAccess function configured');
    }

    return this._requestMediaKeySystemAccess;
  }

  /**
   * Handles obtaining access to a key-system
   * @private
   * @param {string} keySystem
   * @param {MediaKeySystemAccess} mediaKeySystemAccess https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemAccess
   */
  private _onMediaKeySystemAccessObtained(
    keySystem: KeySystems,
    mediaKeySystemAccess: MediaKeySystemAccess
  ): Promise<MediaKeys> {
    logger.log(`Access for key-system "${keySystem}" obtained`);

    // If no MediaKeys exist, create one, otherwise re-use the same one
    if (this._mediaKeys) {
      const mediaKeys: MediaKeys = this._mediaKeys;
      const mediaKeysListItem: MediaKeysListItem = {
        mediaKeys: mediaKeys,
        mediaKeysSessionInitialized: false,
        mediaKeySystemAccess: mediaKeySystemAccess,
        mediaKeySystemDomain: keySystem,
      };

      this._mediaKeysList.push(mediaKeysListItem);

      const mediaKeysPromise = Promise.resolve().then(() => {
        this._onMediaKeysCreated();
        return mediaKeys;
      });

      return mediaKeysPromise;
    } else {
      const mediaKeysListItem: MediaKeysListItem = {
        mediaKeysSessionInitialized: false,
        mediaKeySystemAccess: mediaKeySystemAccess,
        mediaKeySystemDomain: keySystem,
      };

      const mediaKeysPromise = Promise.resolve()
        .then(() => mediaKeySystemAccess.createMediaKeys())
        .then((mediaKeys) => {
          this._mediaKeysList.push(mediaKeysListItem);

          mediaKeysListItem.mediaKeys = mediaKeys;

          this._mediaKeys = mediaKeys;

          logger.log(`Media-keys created for key-system "${keySystem}"`);

          this._onMediaKeysCreated();

          return mediaKeys;
        });

      mediaKeysPromise.catch((err) => {
        logger.error('Failed to create media-keys:', err);
      });

      return mediaKeysPromise;
    }
  }

  /**
   * Handles key-creation (represents access to CDM). We are going to create key-sessions upon this
   * for all existing keys where no session exists yet.
   *
   * @private
   */
  private _onMediaKeysCreated() {
    // check for all key-list items if a session exists, otherwise, create one
    this._mediaKeysList.forEach((mediaKeysListItem) => {
      if (!mediaKeysListItem.mediaKeysSession) {
        // mediaKeys is definitely initialized here
        mediaKeysListItem.mediaKeysSession = mediaKeysListItem.mediaKeys!.createSession();
        this._haveKeySession = true;
        this._onNewMediaKeySession(mediaKeysListItem.mediaKeysSession);
      }
    });
  }

  /**
   * @private
   * @param {*} keySession
   */
  private _onNewMediaKeySession(keySession: MediaKeySession) {
    logger.log(`New key-system session ${keySession.sessionId}`);

    keySession.addEventListener(
      'message',
      (event: MediaKeyMessageEvent) => {
        this._onKeySessionMessage(keySession, event.message);
      },
      false
    );
  }

  /**
   * @private
   * @param {MediaKeySession} keySession
   * @param {ArrayBuffer} message
   */
  private _onKeySessionMessage(
    keySession: MediaKeySession,
    message: ArrayBuffer
  ) {
    logger.log('Got EME message event, creating license request');

    this._requestLicense(message, (data: ArrayBuffer) => {
      logger.log(
        `Received license data (length: ${
          data ? data.byteLength : data
        }), updating key-session`
      );
      keySession.update(data);
    });
  }

  /**
   * @private
   * @param e {MediaEncryptedEvent}
   */
  private onMediaEncrypted(e: MediaEncryptedEvent) {
    if (e.initDataType && e.initData) {
      this._processMediaEncrypted(e.initDataType, e.initData);
    }
  };

  /**
   * @private
   * @param e {MediaEncryptedEvent}
   */
  private _processMediaEncrypted = (
    initDataType: string,
    initData: ArrayBuffer
  ) => {
    if (this._currentPssh === this._keySystemPssh) {
      logger.log('Ignore media encrypted for duplicated PSSH');
      return;
    }
    this._keySystemPssh = this._currentPssh;
    logger.log(`Media is encrypted using "${initDataType}" init data type`);

    if (!this.mediaKeysPromise) {
      logger.error(
        'Fatal: Media is encrypted but no CDM access or no keys have been requested'
      );
      this.hls.trigger(Events.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_KEYS,
        fatal: true,
      });
      return;
    }

    const finallySetKeyAndStartSession = (mediaKeys) => {
      if (!this._media) {
        return;
      }
      this._attemptSetMediaKeys(mediaKeys);
      this._generateRequestWithPreferredKeySession(initDataType, initData);
    };

    // Could use `Promise.finally` but some Promise polyfills are missing it
    this.mediaKeysPromise
      .then(finallySetKeyAndStartSession)
      .catch(finallySetKeyAndStartSession);
  }

  /**
   * @private
   */
  private _attemptSetMediaKeys(mediaKeys?: MediaKeys) {
    if (!this._media) {
      throw new Error(
        'Attempted to set mediaKeys without first attaching a media element'
      );
    }

    if (!this._hasSetMediaKeys) {
      // FIXME: see if we can/want/need-to really to deal with several potential key-sessions?
      const keysListItem = this._getMediaKeys();
      if (!keysListItem || !keysListItem.mediaKeys) {
        logger.error(
          'Fatal: Media is encrypted but no CDM access or no keys have been obtained yet'
        );
        this._keySystemPssh = null;
        this.hls.trigger(Events.ERROR, {
          type: ErrorTypes.KEY_SYSTEM_ERROR,
          details: ErrorDetails.KEY_SYSTEM_NO_KEYS,
          fatal: true,
        });
        return;
      }

      logger.log('Setting keys for encrypted media');

      this._media.setMediaKeys(keysListItem.mediaKeys);
      this._hasSetMediaKeys = true;
    }
  }

  /**
   * @private
   */
  private _getMediaKeys(): MediaKeysListItem {
    return this._mediaKeysList[this._mediaKeysList.length - 1];
  }

  /**
   * @private
   */
  private _generateRequestWithPreferredKeySession(
    initDataType: string,
    initData: ArrayBuffer | null
  ) {
    // FIXME: see if we can/want/need-to really to deal with several potential key-sessions?
    const keysListItem = this._getMediaKeys();
    if (!keysListItem) {
      logger.error(
        'Fatal: Media is encrypted but not any key-system access has been obtained yet'
      );
      this._keySystemPssh = null;
      this.hls.trigger(Events.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_ACCESS,
        fatal: true,
      });
      return;
    }

    if (keysListItem.mediaKeysSessionInitialized) {
      logger.warn('Key-Session already initialized but requested again');
      return;
    }

    const keySession = keysListItem.mediaKeysSession;
    if (!keySession) {
      logger.error('Fatal: Media is encrypted but no key-session existing');
      this.hls.trigger(Events.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_SESSION,
        fatal: true,
      });
      return;
    }

    // initData is null if the media is not CORS-same-origin
    if (!initData) {
      logger.warn(
        'Fatal: initData required for generating a key session is null'
      );
      this.hls.trigger(Events.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_INIT_DATA,
        fatal: true,
      });
      return;
    }

    logger.log(
      `Generating key-session request for "${initDataType}" init data type`
    );
    keysListItem.mediaKeysSessionInitialized = true;

    keySession
      .generateRequest(initDataType, initData)
      .then(() => {
        logger.debug('Key-session generation succeeded');
      })
      .catch((err) => {
        logger.error('Error generating key-session request:', err);
        this.hls.trigger(Events.ERROR, {
          type: ErrorTypes.KEY_SYSTEM_ERROR,
          details: ErrorDetails.KEY_SYSTEM_NO_SESSION,
          fatal: false,
        });
      });
  }

  /**
   * @private
   * @param {string} url License server URL
   * @param {ArrayBuffer} keyMessage Message data issued by key-system
   * @param {function} callback Called when XHR has succeeded
   * @returns {XMLHttpRequest} Unsent (but opened state) XHR object
   * @throws if XMLHttpRequest construction failed
   */
  private _createLicenseXhr(
    url: string,
    keyMessage: ArrayBuffer,
    callback: (data: ArrayBuffer) => void
  ): XMLHttpRequest {
    const xhr = new XMLHttpRequest();
    xhr.responseType = 'arraybuffer';
    xhr.onreadystatechange = this._onLicenseRequestReadyStageChange.bind(
      this,
      xhr,
      url,
      keyMessage,
      callback
    );

    let licenseXhrSetup = this._licenseXhrSetup;
    if (licenseXhrSetup) {
      try {
        licenseXhrSetup.call(this.hls, xhr, url);
        licenseXhrSetup = undefined;
      } catch (e) {
        logger.error(e);
      }
    }
    try {
      // if licenseXhrSetup did not yet call open, let's do it now
      if (!xhr.readyState) {
        xhr.open('POST', url, true);
      }
      if (licenseXhrSetup) {
        licenseXhrSetup.call(this.hls, xhr, url);
      }
    } catch (e) {
      // IE11 throws an exception on xhr.open if attempting to access an HTTP resource over HTTPS
      throw new Error(`issue setting up KeySystem license XHR ${e}`);
    }

    return xhr;
  }

  /**
   * @private
   * @param {XMLHttpRequest} xhr
   * @param {string} url License server URL
   * @param {ArrayBuffer} keyMessage Message data issued by key-system
   * @param {function} callback Called when XHR has succeeded
   */
  private _onLicenseRequestReadyStageChange(
    xhr: XMLHttpRequest,
    url: string,
    keyMessage: ArrayBuffer,
    callback: (data: ArrayBuffer) => void
  ) {
    switch (xhr.readyState) {
      case 4:
        if (xhr.status === 200) {
          this._requestLicenseFailureCount = 0;
          logger.log('License request succeeded');
          let data: ArrayBuffer = xhr.response;
          const licenseResponseCallback = this._licenseResponseCallback;
          if (licenseResponseCallback) {
            try {
              data = licenseResponseCallback.call(this.hls, xhr, url);
            } catch (e) {
              logger.error(e);
            }
          }
          callback(data);
        } else {
          logger.error(
            `License Request XHR failed (${url}). Status: ${xhr.status} (${xhr.statusText})`
          );
          this._requestLicenseFailureCount++;
          if (this._requestLicenseFailureCount > MAX_LICENSE_REQUEST_FAILURES) {
            this.hls.trigger(Events.ERROR, {
              type: ErrorTypes.KEY_SYSTEM_ERROR,
              details: ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED,
              fatal: true,
            });
            return;
          }

          const attemptsLeft =
            MAX_LICENSE_REQUEST_FAILURES - this._requestLicenseFailureCount + 1;
          logger.warn(
            `Retrying license request, ${attemptsLeft} attempts left`
          );
          this._requestLicense(keyMessage, callback);
        }
        break;
    }
  }

  /**
   * @private
   * @param {MediaKeysListItem} keysListItem
   * @param {ArrayBuffer} keyMessage
   * @returns {ArrayBuffer} Challenge data posted to license server
   * @throws if KeySystem is unsupported
   */
  private _generateLicenseRequestChallenge(
    keysListItem: MediaKeysListItem,
    keyMessage: ArrayBuffer
  ): ArrayBuffer | string {
    switch (keysListItem.mediaKeySystemDomain) {
      case KeySystems.PLAYREADY:
        // For PlayReady CDMs, we need to dig the Challenge out of the XML.
        const keyMessageXml = new DOMParser().parseFromString(
          String.fromCharCode.apply(null, new Uint16Array(keyMessage)),
          'application/xml'
        );
        const challengeElement = keyMessageXml.querySelector('Challenge');
        if (challengeElement && challengeElement.textContent) {
          return atob(challengeElement.textContent);
        } else {
          throw new Error(`Cannot find <Challenge> in key message`);
        }
      case KeySystems.WIDEVINE:
        // For Widevine CDMs, the challenge is the keyMessage.
        return keyMessage;
    }

    throw new Error(
      `unsupported key-system: ${keysListItem.mediaKeySystemDomain}`
    );
  }

  /**
   * @private
   * @param keyMessage
   * @param callback
   */
  private _requestLicense(
    keyMessage: ArrayBuffer,
    callback: (data: ArrayBuffer) => void
  ) {
    logger.log('Requesting content license for key-system');

    const keysListItem = this._getMediaKeys();
    if (!keysListItem) {
      logger.error(
        'Fatal error: Media is encrypted but no key-system access has been obtained yet'
      );
      this.hls.trigger(Events.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_ACCESS,
        fatal: true,
      });
      return;
    }

    try {
      const url = this.getLicenseServerUrl(keysListItem.mediaKeySystemDomain);
      const xhr = this._createLicenseXhr(url, keyMessage, callback);
      logger.log(`Sending license request to URL: ${url}`);
      const challenge = this._generateLicenseRequestChallenge(
        keysListItem,
        keyMessage
      );
      if (keysListItem.mediaKeySystemDomain === KeySystems.PLAYREADY) {
        const playReadyHeaders = makePlayreadyHeaders(keyMessage);

        if (playReadyHeaders.length > 0) {
          playReadyHeaders.forEach((header) => {
            xhr.setRequestHeader(header[0], header[1]);
          });
        }
      }
      xhr.send(challenge);
    } catch (e) {
      logger.error(`Failure requesting DRM license: ${e}`);
      this.hls.trigger(Events.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED,
        fatal: true,
      });
    }
  }

  onMediaAttached(event: Events.MEDIA_ATTACHED, data: MediaAttachedData) {
    if (!this._selectedDrm) {
      return;
    }

    const media = data.media;

    // keep reference of media
    this._media = media;

    if (!this._hasSetMediaKeys) {
      media.addEventListener('encrypted', this._onMediaEncrypted);
    }
  }

  onMediaDetached() {
    const media = this._media;
    const mediaKeysList = this._mediaKeysList;
    if (!media) {
      return;
    }
    media.removeEventListener('encrypted', this._onMediaEncrypted);
    this._media = null;
    this._mediaKeysList = [];
    // Close all sessions and remove media keys from the video element.
    Promise.all(
      mediaKeysList.map((mediaKeysListItem) => {
        if (mediaKeysListItem.mediaKeysSession) {
          return mediaKeysListItem.mediaKeysSession.close().catch(() => {
            // Ignore errors when closing the sessions. Closing a session that
            // generated no key requests will throw an error.
          });
        }
      })
    )
      .then(() => {
        return media.setMediaKeys(null);
      })
      .catch(() => {
        // Ignore any failures while removing media keys from the video element.
      });
  }

  onManifestParsed(event: Events.MANIFEST_PARSED, data: ManifestParsedData) {
    if (!this._selectedDrm) {
      return;
    }

    this._audioCodecs = data.levels
      .map((level) => level.audioCodec)
      .filter(
        (audioCodec: string | undefined): audioCodec is string => !!audioCodec
      );
    this._videoCodecs = data.levels
      .map((level) => level.videoCodec)
      .filter(
        (videoCodec: string | undefined): videoCodec is string => !!videoCodec
      );
  }

  onFragLoaded(event: Events.FRAG_LOADED, data: FragLoadedData) {
    if (!this._selectedDrm) {
      return;
    }

    const frag = data.frag;

    // If new DRM keys exist, let's try to create MediaKeysObject, let's process initData
    if (frag.foundKeys) {
      this._attemptKeySystemAccess(
        KeySystems[this._selectedDrm],
        this._audioCodecs,
        this._videoCodecs
      );
      this._processInitData(frag.drmInfo);
    }

    // add initData and type if they are included in playlist, also wait for keysession
    if (this._initDataType && this._initData && this._haveKeySession) {
      this._processMediaEncrypted(this._initDataType, this._initData);
    }
  }

  /**
   * @private
   */
  private _processInitData(drmInfo) {
    if (!this._selectedDrm) {
      return;
    }

    const drmIdentifier = DRMIdentifiers[this._selectedDrm];

    const selectedDrm = drmInfo.filter(
      (levelkey) => levelkey.keyFormat === drmIdentifier
    );
    const levelkey = selectedDrm.shift();

    const details = levelkey.reluri.split(',');
    const encoding = details[0];
    const pssh = details[1];

    this._currentPssh = pssh;

    if (
      drmIdentifier === 'com.microsoft.playready' &&
      encoding.includes('base64')
    ) {
      this._initData = buildPlayReadyPSSHBox(base64ToUint8Array(pssh)); // Playready is particular about the pssh box, so it needs to be handcrafted.
    } else if (
      drmIdentifier === 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' &&
      encoding.includes('base64')
    ) {
      this._initData = base64ToUint8Array(pssh); // Widevine pssh box
    }

    this._initDataType = InitDataTypes.COMMON_ENCRYPTION;
  }
}

export default EMEController;
