/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
  readonly VITE_PUBLIC_APP_URL?: string;
  /** `.capsule` name of a site directory to link to. Empty hides the link. */
  readonly VITE_CAPSULE_INDEX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
