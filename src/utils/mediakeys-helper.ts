/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMediaKeySystemAccess
 */
export enum KeySystems {
  WIDEVINE = 'com.widevine.alpha',
  PLAYREADY = 'com.microsoft.playready',
}

export enum DRMIdentifiers {
  WIDEVINE = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
  PLAYREADY = 'com.microsoft.playready',
}

/**
 * @see https://www.w3.org/TR/eme-initdata-registry/
 */
export enum InitDataTypes {
  COMMON_ENCRYPTION = 'cenc',
  KEY_IDS = 'keyids',
  WEBM = 'webm',
}

export type MediaKeyFunc = (
  keySystem: KeySystems,
  supportedConfigurations: MediaKeySystemConfiguration[]
) => Promise<MediaKeySystemAccess>;
const requestMediaKeySystemAccess = (function (): MediaKeyFunc | null {
  if (
    typeof self !== 'undefined' &&
    self.navigator &&
    self.navigator.requestMediaKeySystemAccess
  ) {
    return self.navigator.requestMediaKeySystemAccess.bind(self.navigator);
  } else {
    return null;
  }
})();

export { requestMediaKeySystemAccess };
