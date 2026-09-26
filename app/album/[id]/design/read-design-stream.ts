import type { DesignEvent } from "@/lib/types";

/** SSE 응답을 읽어 DesignEvent 로 콜백 (디자인·이미지 프롬프트 화면 공용) */
export async function readDesignStream(
  response: Response,
  onEvent: (event: DesignEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("응답 스트림이 없습니다");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue; // 하트비트 주석(: keep-alive) 등
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()) as DesignEvent);
      } catch {
        /* 부분 프레임 무시 */
      }
    }
  }
}
