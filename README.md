# OneChat

Một cửa sổ trên máy tính để hỏi mọi AI: **Claude · DeepSeek · Gemini · AnythingLLM** (thêm Groq, OpenAI, Ollama, endpoint tự chọn). Giao diện Việt/Anh, nhập bằng giọng nói, PromptGate, đính kèm tệp/thư mục, tự liên kết memory của Claude, nhớ thói quen "việc nào dùng AI nào".

*One desktop window for every AI. Vietnamese/English UI, voice input, PromptGate, local files and folders, Claude memory, habit-based routing. English notes are at the end.*

## Cài đặt

Cần **Windows 10/11**, **Node.js 22+**, và Chrome hoặc Edge (cho chế độ 🖱 Thao tác). Có sẵn [Claude Code](https://claude.com/claude-code) đã đăng nhập thì Claude chạy được ngay, không cần khoá API.

```bash
git clone https://github.com/huuthanhueh-debug/onechatai.git
cd onechatai
npm install
npm start
```

Tạo lối tắt Desktop (phím `Ctrl+Alt+A`): `npm run shortcut`. Kiểm tra: `npm test`.

## Chạy

| Cách | Lệnh |
|---|---|
| Lối tắt Desktop (không hiện cửa sổ đen) | bấm đúp **OneChat** hoặc nhấn `Ctrl+Alt+A` |
| Tạo lại lối tắt | `npm run shortcut` (thêm `-- -StartMenu` để có cả trong Start) |
| Dòng lệnh | `npm start` hoặc bấm đúp `OneChat.cmd` |
| Chạy test | `npm test` · gọi Claude thật: `set ONECHAT_LIVE=1 && npm run test:live` |

App mở thành cửa sổ riêng (Electron, có biểu tượng ở khay hệ thống, tự chạy cùng Windows) với máy chủ cục bộ tại `http://127.0.0.1:4780`. Nếu máy chủ dừng bất thường, app tự khởi động lại nó và cửa sổ tự nối lại, giữ nguyên câu đang gõ. Muốn chạy trong trình duyệt: `npm run start:browser`.

## Dùng ngay không cần khoá API

- **Claude** chạy qua Claude Code đã đăng nhập sẵn trên máy (`claude -p`, chế độ chỉ trả lời: không công cụ, không đọc tệp, không nạp hook/plugin). Tính vào gói Claude của bạn.
- AI nào chưa có khoá: bấm Gửi sẽ mở ô nhập khoá ngay trong cửa sổ. App không tự mở cửa sổ nào khác.
- Muốn trả lời ngay trong app: **⚙ Cài đặt → Các AI**, dán khoá API. Khoá được kiểm tra ngay khi lưu, mã hoá AES-256 bằng một khoá riêng của máy (`%LOCALAPPDATA%\OneChat\secret.key`), và không bao giờ gửi về giao diện.

| AI | Cách kết nối | Ghi chú |
|---|---|---|
| Claude (Claude Code) | CLI trên máy | không cần khoá |
| Claude API | SDK chính thức `@anthropic-ai/sdk` | mặc định `claude-opus-5-5`, có prompt caching, tự bật fallback khi model từ chối |
| DeepSeek, Gemini, Groq, OpenAI | API tương thích OpenAI | bấm ↻ để tải danh sách model mới nhất |
| AnythingLLM | `http://localhost:3001/api/v1/openai` | mỗi workspace là một "model"; cần khoá Developer API |
| Ollama, Custom | URL tự điền | |

## Tính năng

- **PromptGate**: mỗi câu hỏi được chấm 0–100 ngay khi gõ (cục bộ, 0 token). Câu yếu → thẻ 3 bản **A Gọn / B Chuẩn / C Sâu** để bấm chọn; bản theo quy tắc hiện tức thì, AI phụ điền chi tiết sau vài giây. Không bao giờ chặn: Enter lần nữa hoặc `//` ở đầu là gửi nguyên bản.
- **Memory**: tự tìm mọi thư mục `~/.claude/projects/*/memory` (chỉ đọc). Mục nào khớp câu hỏi hiện thành thẻ 🧠 để bạn bỏ bớt trước khi gửi; 📌 để luôn gắn. Chỗ giống mật khẩu/khoá API được che trước khi rời máy. Nút **📌 Ghi nhớ** dưới câu trả lời lưu thành ghi chú riêng của OneChat. **⬇ Xuất tất cả** tải về một tệp chứa mọi memory (đã che chỗ giống mật khẩu); **⬆ Nhập** nhận tệp `.md`, `.txt`, `.json` từ nơi khác và bỏ qua mục trùng nội dung. Dòng lệnh: `npm run export-memory -- <tệp>`.
- **Tệp và thư mục**: duyệt ổ đĩa, tìm theo tên (không cần gõ dấu), ghim thư mục hay dùng, kéo thả hoặc dán tệp. Đọc được văn bản, mã nguồn, `.docx`, `.xlsx`, `.pptx`, `.pdf`. Thư mục gửi dạng cây tên tệp.
- **Thói quen**: app ghi loại việc (dịch, tóm tắt, viết, sửa lỗi…) đi với AI nào, gợi ý chuyển đúng lúc; 👍/👎 chỉnh gợi ý; ghim một AI cho một loại việc; chế độ **✨ Tự chọn** định tuyến tự động.
- **Giọng nói**: nút 🎤 hoặc `Ctrl+M`, đổi Việt/Anh bằng nút VI/EN. Dùng bộ nhận giọng nói của Chrome/Edge (miễn phí); dự phòng Whisper khi có khoá Groq hoặc OpenAI.
- **Tiết kiệm token**: đếm token ước lượng trước khi gửi và số thật sau khi trả lời; ngân sách lịch sử; thu gọn hội thoại dài thành tóm tắt; memory chọn lọc theo ngân sách; chế độ trả lời gọn; bản A của PromptGate.

Phím tắt: `Enter` gửi · `Shift+Enter` xuống dòng · `Ctrl+K` trò chuyện mới · `Ctrl+M` nói · `Alt+1…9` đổi AI · `Ctrl+,` cài đặt · `Esc` dừng/đóng.

## Bảo mật

Máy chủ chỉ nghe ở `127.0.0.1`. Mọi lệnh API cần token sinh ngẫu nhiên mỗi lần chạy (nhúng trong trang), kèm kiểm tra `Host` và `Origin`, nên trang web khác hay máy khác trong mạng không điều khiển hoặc đọc tệp qua app được. Trang dùng CSP chặt, câu trả lời của AI được escape trước khi hiển thị.

Dữ liệu nằm ở `%APPDATA%\OneChat` (`settings.json`, `secrets.json`, `conversations\`, `usage.json`, `memory\`). Đổi chỗ: `node server.js --data <thư mục> --port <cổng>`.

## Cấu trúc

```
electron/main.js     vỏ app: cửa sổ, khay hệ thống, tự chạy cùng Windows, tự dựng lại máy chủ
server.js            máy chủ HTTP + API (chỉ nghe ở 127.0.0.1)
lib/providers/       index (danh mục AI, ảnh) · openai-compat · anthropic (SDK) · claude-cli
lib/                 config · secrets (AES-256) · tokens · memory · router · files · promptgate · store · stt
                     agent · council · operator + optools + chrome (Thao tác) · output (thư mục đầu ra, khôi phục)
                     media · imagegen · quota (% còn lại) · studio (mindmap, biểu đồ, video)
public/              index.html · app.js · app.css · i18n.js (VI/EN) · md.js (Markdown an toàn) · studio.js
tests/               unit · providers · server · agent · smart · operator · lifetime (máy chủ giả, không gọi mạng)
vendor/promptgate/   bản engine PromptGate dự phòng khi không có plugin cạnh thư mục này
```

## Cập nhật 13/11/2026 (bản app riêng + Agent)

- **App riêng, không cần Chrome:** lối tắt Desktop mở OneChat bằng Electron (cửa sổ và biểu tượng riêng, nằm ở khay hệ thống, tự chạy cùng Windows; bấm chuột phải biểu tượng khay để tắt tự chạy hoặc thoát). Lệnh: `npm start`. Bản chạy trong trình duyệt vẫn còn: `npm run start:browser`.
- **Giọng nói trong app riêng:** ghi âm rồi chép lời bằng Whisper qua khoá Groq (hoặc OpenAI); không còn gõ chữ trực tiếp theo lời nói như trong Chrome.
- **Đã bỏ Grok và Copilot** khỏi danh sách AI.
- **Chế độ Agent (nút 🤖):** AI soạn nháp → một AI khác chấm điểm và nêu lỗi → AI soạn sửa lại, lặp tới khi đạt điểm hoặc hết số vòng (Cài đặt → Chung). Mỗi lần chấm ra lỗi thật sẽ để lại một *bài học* theo loại việc, tự chèn vào các lần sau; xem và xoá ở tab Thói quen. Nút **🔁 Cải thiện** dưới câu trả lời chạy vòng này trên câu trả lời có sẵn, kèm góp ý của bạn. Agent tốn token gấp vài lần và không chạy mã trên máy.
- **Lưu đầy đủ:** mỗi lượt hỏi được ghi thêm vào `history.jsonl`; toàn bộ dữ liệu (chat, ghi chú memory, thói quen, bài học, khoá đã mã hoá) được sao lưu mỗi ngày vào `backups/YYYY-MM-DD/` trong `%APPDATA%\OneChat` (giữ mãi, không bao giờ tự xoá); thống kê thói quen không còn bị cắt sau 120 ngày.
- **Kiểm tra khoá:** `npm run check-keys` gọi thử từng AI đã có khoá và in kết quả (khoá chỉ hiện dạng che).

## Giới hạn đã biết

- PDF dạng ảnh quét không trích được chữ (gửi ảnh chụp trang thì được).
- Ngày trong Excel hiện dưới dạng số sê-ri.
- Claude qua CLI gộp lịch sử thành một prompt nên không tận dụng prompt caching giữa các lượt (Claude API thì có).
- Mã model mặc định có thể cũ đi theo thời gian: bấm ↻ để tải danh sách mới từ nhà cung cấp.
- Dựng ảnh thật cần tài khoản có quyền dựng ảnh (Gemini trả phí hoặc OpenAI còn credit).

## Cập nhật tối 13/11/2026 (ảnh, % còn lại, Hội đồng, Dựng)

- **Ảnh đính kèm:** dán (Ctrl+V), kéo thả hoặc chọn trong tab Tệp. Ảnh được thu nhỏ còn tối đa 1568 px rồi gửi như ảnh thật. Claude, Gemini, OpenAI và model `qwen` của Groq nhìn được ảnh; DeepSeek và AnythingLLM thì không, nên một AI nhìn được sẽ mô tả ảnh giúp (có báo trong câu trả lời; tắt ở Cài đặt → Chung).
- **% còn lại trên từng nút AI:** chỉ là số do nhà cung cấp báo. Claude Code: phiên 5 giờ và tuần. Claude API, Groq: hạn mức tốc độ (⚡). DeepSeek: số dư tiền. Gemini, OpenAI, AnythingLLM không báo gì → đặt "hạn mức tự đặt" (triệu token/tháng) ở Cài đặt → Các AI. Bảng đầy đủ ở tab Thói quen.
- **👥 Hội đồng:** vài AI khác họ cùng trả lời, AI bạn chọn đối chiếu và viết bản cuối. Tốn một lượt gọi cho mỗi AI cộng một lượt tổng hợp; AI trả lời quá chậm bị bỏ qua.
- **🎨 Dựng:** mindmap, biểu đồ, hình vẽ SVG, video trình chiếu (.webm), phân tích tài chính, kế hoạch marketing. Kết quả hiện ngay trong cửa sổ, lưu được SVG/PNG/WebM. Dựng ảnh thật cần tài khoản dựng được ảnh (Gemini trả phí hoặc OpenAI còn credit).
- **Tự chuyển AI khi quá tải:** AI đang chọn báo quá tải, bị giới hạn tốc độ hoặc không phản hồi trong 30 giây thì câu hỏi chuyển sang AI sẵn sàng kế tiếp (có ghi chú dưới câu trả lời). AI đó được bỏ qua 3 phút rồi thử lại; không bị đánh dấu 0% như khi hết credit.
- **🖱 Thao tác (điều khiển máy):** AI tự làm từng bước: tìm kiếm, mở trang, bấm, gõ trong một cửa sổ Chrome riêng của OneChat (hồ sơ riêng, điều khiển qua đường ống, không mở cổng mạng), chụp trang, lưu tệp, mở chương trình, chạy lệnh cmd. Gửi / mua / xoá / tải về / mở chương trình / chạy lệnh luôn hỏi bạn trước; lệnh xoá, cấu hình, PowerShell, tải tệp bị từ chối hẳn; AI không bao giờ gõ mật khẩu hay vượt CAPTCHA. Muốn AI dùng tài khoản của bạn: Cài đặt → Chung → "Mở Chrome của OneChat để đăng nhập", tự đăng nhập một lần rồi đóng cửa sổ đó.
- **📂 Thư mục đầu ra:** mỗi cuộc trò chuyện có một thư mục riêng `Documents\OneChat\YYYY-MM-DD <tiêu đề>` (đổi gốc ở Cài đặt → Chung), app tự tạo khi lưu lần đầu. Tệp AI ghi, ảnh chụp trang, mindmap / biểu đồ / video (nút "Lưu vào thư mục") và câu trả lời (nút 💾 Lưu) đều vào đây. Không tạo tệp chạy được (.exe, .bat, .ps1, .js…).
- **❓ Hỏi lại khi chưa chắc:** câu hỏi mơ hồ hoặc thiếu chi tiết quan trọng thì AI hỏi lại một câu với 2–4 lựa chọn (đề xuất ★ đứng đầu, có lý do) và ô "Ý khác" để tự gõ. Trong chế độ Thao tác, AI hỏi giữa chừng bằng công cụ `ask_user`. Tắt ở Cài đặt → Chung.
- **Tự bật Thao tác:** câu hỏi rõ ràng cần vào web ("vào YouTube…", "tìm … trên Google", có link) tự chạy bằng Thao tác, có ghi chú; trước khi gửi có nút "Lần này trả lời thường".
- **↶ Khôi phục (rollback):** ghi đè tệp thì bản cũ được giữ trong `.phien-ban`; chạy lệnh thì cả thư mục đầu ra được sao lưu ngay trước đó. Nút "↶ Khôi phục" dưới câu trả lời đưa bản cũ về, và trước khi khôi phục cũng giữ trạng thái hiện tại. Không có gì bị xoá.
- **Kiểm tra từ bên ngoài:** `curl http://127.0.0.1:4780/api/ping` trả về phiên bản, thời gian chạy và danh sách tính năng (không cần token, không lộ dữ liệu). Chỉ nghe trên máy này, không mở ra mạng.
- **Biểu tượng Taskbar:** `OneChat.cmd` và `OneChat.vbs` giờ mở app riêng (logo OneChat). Muốn mở kiểu trình duyệt như cũ: `OneChat.cmd --browser`.

---

## English

**Install:** Windows 10/11 and Node.js 22+. `git clone https://github.com/huuthanhueh-debug/onechatai.git`, `cd onechatai`, `npm install`, then `npm start` (or the Desktop shortcut created by `npm run shortcut`, hotkey `Ctrl+Alt+A`). Tests: `npm test`.

**No key needed to start:** Claude answers through the Claude Code CLI already signed in on the machine (answer-only mode). An AI without a key asks for it inside the window; the app never opens another window by itself. Paste API keys under **Settings → AIs**: each is checked on save, encrypted with AES-256 using a per-machine key file, and never sent back to the page.

**What it does:** PromptGate scoring with click-to-pick A/B/C rewrites (never blocks) · auto-links every Claude memory folder read-only, attaches only entries relevant to the prompt, masks secret-like values · attaches local files and folders (text, code, docx, xlsx, pptx, pdf) · learns which AI you use for which kind of task and suggests or auto-routes · Vietnamese/English voice input · token estimates, history budget, compaction · pictures in chat (a vision-capable AI describes them for one that cannot see) · "% left" per AI as reported by the provider · automatic switch to another AI when one is out of credit, overloaded or not running · Agent mode (draft → review → revise, with lessons) · Council mode (several AIs answer, one writes the final answer) · mind maps, charts, SVG drawings and slideshow videos rendered in the window · Operator mode (the AI works step by step in its own Chrome window, saves files, opens programs and runs commands, always asking before anything that cannot be undone) · a per-conversation output folder with kept versions and one-click restore · asks back with options to click when a request is unclear.

**Security:** binds to 127.0.0.1; every API call needs a per-run token plus matching Host/Origin; strict CSP; model output is escaped before rendering. Keys and chats stay in `%APPDATA%\OneChat` on your machine and are never part of this repository.
