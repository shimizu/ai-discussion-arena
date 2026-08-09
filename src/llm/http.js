/**
 * 3社のアダプタが共有するHTTPユーティリティ。
 * レート制限と一時的なサーバーエラーは指数バックオフで再試行する。
 */

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 529]);
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 20000;

/**
 * 中断シグナルを尊重しながら待機する。待機中のabortは即座に失敗させ、
 * 討議を止めたのに裏で再試行が走り続ける状態を防ぐ。
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function backoffMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * レスポンスからエラーメッセージを取り出す。各社でJSONの形が違うため、
 * よくある場所を順に見て、最後は生テキストへフォールバックする。
 */
async function extractErrorMessage(response, providerLabel) {
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // JSONでなければ生テキストを使う。
  }

  const message =
    payload?.error?.message ??
    payload?.error?.status ??
    payload?.message ??
    (text ? text.slice(0, 300) : "");

  return `${providerLabel} APIエラー（HTTP ${response.status}）${
    message ? `: ${message}` : ""
  }`;
}

/**
 * JSONをPOSTし、パース済みのボディを返す。
 */
export async function postJson({
  url,
  headers,
  body,
  signal,
  providerLabel,
  maxRetries = DEFAULT_MAX_RETRIES,
  timeoutMs = 180000,
}) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // 利用者の中断とタイムアウトの両方でabortできるよう合成する。
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const compositeSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: compositeSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (timeoutSignal.aborted) {
        lastError = new Error(`${providerLabel} APIがタイムアウトしました。`);
      } else {
        // CORS拒否やネットワーク断はfetch自体が例外になる。原因が分かりにくいので補足を添える。
        lastError = new Error(
          `${providerLabel} APIへ接続できませんでした。APIキー、ネットワーク、ブラウザ拡張によるリクエスト遮断を確認してください（${
            error instanceof Error ? error.message : String(error)
          }）。`,
        );
      }
      if (attempt < maxRetries) {
        await delay(backoffMs(null, attempt), signal);
        continue;
      }
      throw lastError;
    }

    if (response.ok) return response.json();

    if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
      await delay(backoffMs(response, attempt), signal);
      continue;
    }

    throw new Error(await extractErrorMessage(response, providerLabel));
  }

  throw lastError ?? new Error(`${providerLabel} APIの呼び出しに失敗しました。`);
}

/**
 * モデル一覧などのGETを行う。キー検証を兼ねるため再試行はしない。
 */
export async function getJson({ url, headers, signal, providerLabel }) {
  let response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    throw new Error(
      `${providerLabel} APIへ接続できませんでした（${
        error instanceof Error ? error.message : String(error)
      }）。`,
    );
  }
  if (!response.ok) {
    throw new Error(await extractErrorMessage(response, providerLabel));
  }
  return response.json();
}
