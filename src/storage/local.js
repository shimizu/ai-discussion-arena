/**
 * localStorageの薄いラッパー。
 *
 * プライベートモードや設定次第で getItem/setItem 自体が例外を投げるため、
 * 読み書きは常に保護する。保存できなくてもメモリ上の状態で動作は継続する。
 */

export const STORAGE_PREFIX = "ai-discussion.";

export function loadSetting(key, fallback = "") {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 保存の成否を返す。討議記録が容量を食い切るとAPIキーの保存が黙って失敗しうるので、
 * 呼び出し側が失敗を検知できるようにしておく。
 */
export function saveSetting(key, value) {
  try {
    // 不在を「成功」と report しないよう、オプショナルチェーンでは済ませない。
    const store = globalThis.localStorage;
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSetting(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // 削除失敗は無視する。
  }
}
