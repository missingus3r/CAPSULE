/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
  readonly VITE_PUBLIC_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
