/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_SERVER: string;
  readonly VITE_PUBLIC_JWK: string;
  readonly VITE_PUBLIC_SANDBOX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
