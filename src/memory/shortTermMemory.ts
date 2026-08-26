/**
 * 短期記憶: 直近の会話の要約 + 重要な事実。
 * 長期記憶(Qdrant、ツール呼び出し経由)と違い、こちらは毎回そのまま
 * inputに含める（システムプロンプトの直後に差し込む想定）。
 *
 * このクラス自体はデータ保持とレンダリングだけを担当する。
 * 「いつ・どう要約するか」は ZundamonSession 側の責務
 * （会話ログが一定長を超えたら古い部分を要約して差し替える）。
 */
export class ShortTermMemory {
  private summary = "";
  private facts: string[] = [];

  getSummary(): string {
    return this.summary;
  }

  getFacts(): string[] {
    return [...this.facts];
  }

  /** 新しい要約で置き換える（古い要約を含めて圧縮した結果を渡す想定）。 */
  setSummary(summary: string): void {
    this.summary = summary;
  }

  addFact(fact: string): void {
    const trimmed = fact.trim();
    if (trimmed && !this.facts.includes(trimmed)) {
      this.facts.push(trimmed);
    }
  }

  isEmpty(): boolean {
    return this.summary === "" && this.facts.length === 0;
  }

  /** システムプロンプトに続けてinputへ差し込むブロック。何も無ければ空文字。 */
  render(): string {
    if (this.isEmpty()) return "";
    const lines: string[] = ["【短期記憶】"];
    if (this.summary) lines.push(`これまでの会話の要約: ${this.summary}`);
    if (this.facts.length > 0) {
      lines.push("直近で分かった重要な事実:");
      for (const f of this.facts) lines.push(`- ${f}`);
    }
    return lines.join("\n");
  }
}
