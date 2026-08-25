export interface AppConfig {
  schemaVersion: number;
  productName: string;
  version: string;
  identifier: string;
  slug: string;
  description: string;
  authors: string[];
  copyright: string;
  iconSource: string;
  harness: {
    repository: string;
    ref: string;
  };
}

export const appConfig: AppConfig = __APP_CONFIG__;
