/** 検索プロバイダーの設定・通信・応答エラーを呼び出し側で識別するための型。 */
export class SearchProviderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SearchProviderError";
    this.cause = cause;
  }
}
