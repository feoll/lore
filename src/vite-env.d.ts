/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAIN_APP?: string;
  readonly VITE_VIEW_HINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
