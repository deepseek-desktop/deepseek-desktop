export interface AppConfig {
  schemaVersion: number;
  productName: string;
  version: string;
  displayVersion: string;
  windowTitle: string;
  identifier: string;
  slug: string;
  description: string;
  authors: string[];
  repository: string;
  copyright: string;
  iconSource: string;
  harness: {
    repository: string;
    ref: string;
  };
  harnessUpdate: {
    manifestUrl: string;
    channel: "stable" | "preview";
    autoUpdate: boolean;
    publisher: string;
    publicKey: string;
    desktopProtocolVersion: number;
    harnessProtocolVersion: number;
    credentialProtocolVersion: number;
  };
  release: {
    channel: "local" | "community" | "stable";
    signed: boolean;
  };
  toolchain: {
    nodeVersion: string;
    rustVersion: string;
  };
}

export const appConfig: AppConfig = __APP_CONFIG__;
