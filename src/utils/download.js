/**
 * ブラウザにテキストファイルを保存させる処理。
 * サーバーを持たないアプリなので、書き出しはすべてObjectURL経由で行う。
 */

// Windows/macOSのファイル名に使えない記号。
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;

function isControlChar(char) {
  const code = char.codePointAt(0);
  return code < 0x20 || code === 0x7f;
}

/**
 * 討議テーマをそのままファイル名に使うと、記号や改行が入って保存に失敗する。
 * 使えない文字を落とし、長さも切り詰める。
 */
export function sanitizeFileName(name, maxLength = 40) {
  const cleaned = Array.from(String(name ?? ""))
    // 制御文字は空白に置き換えてから畳む。単純に削ると単語が繋がってしまう。
    .map((char) => (isControlChar(char) ? " " : char))
    .join("")
    .replace(UNSAFE_FILENAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLength).trim();
}

/**
 * テキストをファイルとしてダウンロードさせる。
 *
 * revokeObjectURLはclick()直後に同期で呼ぶと、ブラウザが読み出す前にURLが
 * 無効化されてダウンロードが中断されることがある。遅らせて解放する。
 */
export function downloadTextFile(fileName, text, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
