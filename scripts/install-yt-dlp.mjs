/** Install the verified upstream zipapp only inside this project. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const VERSION = "2026.08.19";
const SHA256 = "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6";
const URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp`;
const TOOL_DIR = path.resolve(".tools");
const TOOL_PATH = path.join(TOOL_DIR, "yt-dlp");
const MAX_BYTES = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);

async function verify(file) {
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== SHA256) {
    throw new Error(`SHA256 불일치: ${file}`);
  }
  const { stdout } = await execFileAsync(file, ["--ignore-config", "--version"], {
    timeout: 15_000,
  });
  if (stdout.trim() !== VERSION) {
    throw new Error(`yt-dlp 버전 불일치: ${stdout.trim()} (예상 ${VERSION})`);
  }
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
    throw new Error("사용법: node scripts/install-yt-dlp.mjs [--check]");
  }
  if (process.argv[2] === "--check") {
    await verify(TOOL_PATH);
    console.log(`앱 전용 yt-dlp ${VERSION} 검증 완료: ${TOOL_PATH}`);
    return;
  }

  try {
    await verify(TOOL_PATH);
    console.log(`앱 전용 yt-dlp ${VERSION} 이미 설치됨: ${TOOL_PATH}`);
    return;
  } catch {
    // 누락 또는 잘못된 바이너리는 검증된 공식 파일로 교체한다.
  }

  const response = await fetch(URL, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body) {
    throw new Error(`공식 릴리스 다운로드 실패 (HTTP ${response.status})`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("다운로드 파일이 허용 크기를 초과했습니다");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SHA256) {
    throw new Error(`공식 릴리스 SHA256 불일치 (받은 값 ${digest})`);
  }

  await mkdir(TOOL_DIR, { recursive: true });
  const temp = path.join(TOOL_DIR, `.yt-dlp-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { mode: 0o755, flag: "wx" });
    await chmod(temp, 0o755);
    await verify(temp);
    await rename(temp, TOOL_PATH);
  } finally {
    await rm(temp, { force: true });
  }
  console.log(`앱 전용 yt-dlp ${VERSION} 설치·검증 완료: ${TOOL_PATH}`);
}

main().catch((error) => {
  console.error(`yt-dlp 설치 실패: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
