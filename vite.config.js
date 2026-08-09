import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 本番ビルドのindex.htmlへCSPのmetaを注入する。
// connect-src を「3社のLLM API + e-Stat + World Bank」だけに限定し、
// APIキーが他のホストへ送られる経路を塞ぐ。
// 開発時(serve)はViteのHMRがインラインscriptを注入するため適用しない。
const CONNECT_SRC = [
  "'self'",
  "https://api.anthropic.com",
  "https://api.openai.com",
  "https://generativelanguage.googleapis.com",
  "https://api.e-stat.go.jp",
  "https://api.worldbank.org",
].join(" ");

const CSP = [
  "default-src 'self'",
  `connect-src ${CONNECT_SRC}`,
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

function cspPlugin() {
  return {
    name: "inject-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "</title>",
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  // 相対パスでアセットを参照させ、配置階層に依存せず動くようにする。
  base: "./",
  server: { port: 3100 },
  preview: { port: 3100 },
  plugins: [react(), cspPlugin()],
});
