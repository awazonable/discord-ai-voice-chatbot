/**
 * 中断(abort)由来のエラーかどうかを判定する。
 *
 * モック実装は `DOMException("Aborted", "AbortError")` を投げるが、
 * OpenAI SDK は中断時に `APIUserAbortError`（name は "APIUserAbortError"）を
 * 投げるため、DOMException だけを見ていると実APIでの中断が
 * 「想定外のエラー」として再スローされてしまう。
 * 両方を吸収するためのヘルパー。
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;

  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError" || name === "APIUserAbortError") return true;
  }

  return false;
}
