# 학교 캐릭터 공모전 투표 사이트

학생들이 제출한 캐릭터 작품을 갤러리로 보고, 로그인 후 **하트·댓글로 투표**하는 사이트입니다.
교사용 관리자 페이지에서 작품 업로드, 투표 시작/마감, 결과 집계(CSV)를 할 수 있습니다.

- 프론트: HTML + CSS + Vanilla JS (빌드 도구 없음)
- 백엔드: Supabase (Database + Storage + Auth), supabase-js v2 CDN
- 배포: GitHub Pages (main 브랜치 루트)

```
vote/
├─ index.html          학생용 투표 사이트
├─ admin.html          교사용 관리자 페이지
├─ css/style.css       학생용 스타일
├─ css/admin.css       관리자 스타일
├─ js/config.js        Supabase URL · anon key (여기만 바꾸면 다른 프로젝트에서도 사용 가능)
├─ js/app.js           학생용 로직
├─ js/admin.js         관리자 로직
├─ supabase/schema.sql SQL Editor 에 붙여넣는 DB 설정 (테이블·RLS·함수·Storage)
├─ 작품정보.csv         작품 일괄 등록용 CSV 양식
└─ README.md
```

---

## 1. Supabase 설정 (처음 한 번)

### 1-1. 프로젝트 만들기
1. https://supabase.com 에 로그인 → **New project** → 이름 `db_hyunuk`, 비밀번호·지역(Northeast Asia (Seoul) 권장) 입력 → 생성.
2. 왼쪽 메뉴 **Project Settings → API** 에서 두 값을 확인합니다.
   - **Project URL** (예: `https://xxxx.supabase.co`)
   - **anon public** 키 (publishable key)
3. `js/config.js` 를 열어 두 값을 넣습니다. (이미 들어 있으면 확인만)

> ⚠️ `service_role` / `secret` 키는 **절대** 코드에 넣지 마세요. GitHub Pages 는 코드가 전부 공개됩니다.
> anon 키는 공개되어도 안전하도록 DB 의 RLS 정책이 모든 접근을 제한합니다.

### 1-2. schema.sql 실행
1. 왼쪽 메뉴 **SQL Editor → New query**.
2. `supabase/schema.sql` 파일 내용을 **전부** 복사해 붙여넣고 **Run**.
3. 아래쪽에 `Success. No rows returned` 가 나오면 성공입니다.
   - 테이블 7개(settings, secrets, admins, students, artworks, likes, comments)
   - RLS 정책, 함수, Storage 버킷 `artworks` 가 한 번에 만들어집니다.
   - 여러 번 실행해도 안전합니다. (데이터가 지워지지 않음)

### 1-3. 첫 관리자(교사) 계정 만들기
schema.sql 맨 아래 **10번 블록**의 주석을 풀고 실제 이메일·비밀번호로 바꿔 SQL Editor 에서 실행합니다.

```sql
select public.signup_admin('teacher@school.kr', '비밀번호(6자 이상)', 'sonline');
```

- `'sonline'` 은 **관리자 가입 코드** 기본값입니다. (secrets 표에 저장, 브라우저에서 읽을 수 없음)
- 이메일 인증 없이 바로 로그인할 수 있는 계정이 만들어지고 관리자로 등록됩니다.
- 가입 코드를 바꾸려면:
  ```sql
  update public.secrets set value = '새코드' where key = 'admin_signup_code';
  ```
- 계정은 관리자 페이지(admin.html) 로그인 화면의 **관리자 계정 만들기** 에서도 만들 수 있습니다. (가입 코드 필요)

### 1-4. Authentication 설정 (대시보드에서 직접)
| 위치 | 설정 | 이유 |
|---|---|---|
| Authentication → Sign In / Providers → **Anonymous sign-ins** | **켜기** | 학생은 익명 로그인으로 들어옵니다. 안 켜면 "익명 로그인이 꺼져 있어요" 오류 |
| Authentication → Rate Limits → **Anonymous users** (sign-ins per hour per IP) | 학생 수 이상으로 (예: 500) | 기본 30회/시간/IP. 학교 와이파이는 IP 가 같아서 30명 넘으면 막힙니다 |
| Authentication → Sign In / Providers → Email → **Confirm email** | **끄기 (권장)** | 교사 계정 로그인 시 인증 메일 문제를 피합니다 |

### 1-5. (선택) Storage 확인
**Storage** 메뉴에 `artworks` 버킷(Public)이 보이면 정상입니다. schema.sql 이 자동으로 만듭니다.

---

## 2. 로컬 테스트

파일을 더블클릭(file://)해서 열어도 대부분 동작하지만, 브라우저에 따라 막힐 수 있으니 간단한 로컬 서버를 권장합니다.

- VS Code 를 쓰면 **Live Server** 확장 → `index.html` 우클릭 → Open with Live Server
- Python 이 있으면 프로젝트 폴더에서:
  ```bash
  python -m http.server 8000
  ```
  → 브라우저에서 http://localhost:8000 (학생), http://localhost:8000/admin.html (관리자)

### 테스트 순서
1. `admin.html` → 1-3 에서 만든 계정으로 로그인.
2. **작품** 탭 → 이미지 여러 장 드래그 앤 드롭 → (선택) `작품정보.csv` 불러오기 → 제목·출품자·설명 확인 → **전체 업로드**.
3. **대시보드** 탭 → **투표 상태** 스위치 켜기.
4. `index.html` → **참여하기** → 학교·학번·이름·동의 체크 → 하트·댓글 테스트.
5. 다른 브라우저(또는 시크릿 창)에서 **같은 학교·학번·다른 이름**으로 로그인 → "이미 다른 이름으로 등록된 학번" 거부 확인.
6. 같은 학교·학번·같은 이름으로 로그인 → 새 기기로 연결되고, 이전 창에서 하트를 누르면 "로그인이 필요합니다" 안내 확인.
7. **결과** 탭 → 순위표와 CSV 3종 다운로드 확인.

---

## 3. GitHub Pages 배포

1. GitHub 에서 새 저장소 생성 (예: `character-vote`). **Public** 이어야 무료 Pages 가능.
2. 이 폴더의 파일을 **main 브랜치 루트**에 올립니다.
   ```bash
   git init
   git add .
   git commit -m "캐릭터 공모전 투표 사이트"
   git branch -M main
   git remote add origin https://github.com/<아이디>/character-vote.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **main** / **/ (root)** → Save
4. 1~2분 뒤 `https://<아이디>.github.io/character-vote/` 에서 접속됩니다.
   - 관리자: `https://<아이디>.github.io/character-vote/admin.html`
5. 파일을 고친 뒤 다시 `git add . && git commit && git push` 하면 자동 반영됩니다. (반영까지 1~2분, 브라우저 강력 새로고침 Ctrl+F5)

> 학생들에게는 학생용 주소만 안내하고, 관리자 주소는 교사끼리만 공유하세요.
> (관리자 페이지는 계정 없이는 아무것도 할 수 없지만, 주소를 굳이 공개할 필요는 없습니다)

---

## 4. 운영 안내

### 작품 등록
- **작품** 탭에서 이미지를 끌어다 놓으면 대기 목록이 생깁니다. 항목마다 제목·출품자·설명을 입력합니다.
- `작품정보.csv` (열: `제목, 출품자, 설명, 파일명키워드`) 를 불러오면 **파일명에 키워드가 포함된** 항목에 자동으로 채워집니다.
  예: 키워드 `03` → `03_홍길동.png` 와 매칭. 자동 매칭이 안 되면 항목의 드롭다운에서 직접 고릅니다.
- CSV 는 엑셀에서 **CSV UTF-8(쉼표로 분리)** 로 저장하세요.
- 등록 후에도 목록에서 제목·출품자·설명을 바로 고치고 **저장**, **숨김/보이기**, **삭제**(이미지 파일까지 삭제) 할 수 있습니다.

### 투표 진행
- **대시보드** 의 스위치로 시작/마감. 마감하면 학생은 보기만 가능하고 하트·댓글 버튼은 안내 문구로 바뀝니다.
- 사이트 제목·안내문도 대시보드에서 바로 수정됩니다.

### 학생 관리
- **학생** 탭: 학교·학번·이름·마지막 로그인 확인, 검색, CSV 내보내기.
- **기기 해제**: 다른 사람이 학번을 도용한 것 같을 때. 학생이 다시 로그인하면 재연결됩니다.
- **삭제**: 프로필과 그 학생의 하트·댓글이 모두 삭제됩니다.

### 댓글 관리
- **댓글** 탭에서 실제 이름·학번·작품과 함께 봅니다. 부적절한 댓글은 **숨김**(학생에게 안 보임) 또는 **삭제**.
- 학생 화면에는 항상 마스킹된 이름(예: 홍*동)만 보입니다. 마스킹은 DB 에 저장할 때 처리되어 실제 이름이 전달될 경로가 없습니다.

### 결과
- **결과** 탭의 순위표(하트 수 → 댓글 수 순). CSV 3종:
  - 작품별 집계 / 하트 상세(누가 어떤 작품에 언제) / 댓글 상세
- 엑셀에서 바로 열리도록 UTF-8 BOM 이 포함돼 있습니다.

### 공모전이 끝난 뒤 (개인정보 파기)
학생 정보는 공모전 종료 후 즉시 파기한다고 동의받았습니다. 결과 CSV 를 내려받은 뒤 SQL Editor 에서:
```sql
delete from public.students;   -- 하트·댓글도 함께 삭제됨
```
익명 로그인으로 생긴 Auth 사용자도 정리하려면 Authentication → Users 에서 삭제하거나:
```sql
delete from auth.users where is_anonymous = true;
```

---

## 5. 보안 설계 요약

| 항목 | 방법 |
|---|---|
| 키 노출 | anon 키만 사용. service_role 키는 코드에 없음 |
| 표 접근 | 모든 표 RLS 활성화. 학생은 자기 프로필·자기 하트만 조회, 작품·댓글은 공개분만 조회 |
| 학생 쓰기 | `claim_student`, `toggle_like`, `add_comment`, `delete_my_comment` 함수(SECURITY DEFINER)로만 가능. 함수 안에서 투표 기간·본인 여부·200자 제한 재검사 |
| 중복 투표 | (정규화한 학교, 학번) unique 인덱스. 학교명은 띄어쓰기와 "등학교/학교" 꼬리를 무시하고 비교 |
| 학번 도용 | 같은 학교·학번에 다른 이름이면 거부. 재로그인하면 새 기기로 연결이 넘어가고 이전 기기는 투표 불가 |
| 관리자 판정 | `is_admin()` = admins 표 이메일 일치 + 익명 계정 아님 |
| 가입 코드 | secrets 표(정책 없음)에만 저장. `signup_admin` 함수 안에서만 비교 |
| 이름 노출 | 댓글 작성자명은 저장 시점에 마스킹. 하트 수는 함수로만 제공 |

---

## 6. 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| "익명 로그인이 꺼져 있어요" | Authentication → Sign In / Providers → Anonymous sign-ins 켜기 |
| 학생 30명쯤부터 참여하기가 안 됨 ("요청이 너무 많아요") | Authentication → Rate Limits → Anonymous users 값을 올리기 (학교 와이파이는 IP 가 같음) |
| 작품이 안 보이고 "불러오지 못했어요" | `js/config.js` 의 URL/키 확인. schema.sql 을 실행했는지 확인. 브라우저 F12 → Console 의 오류 메시지 확인 |
| 관리자 로그인 시 "관리자로 등록되지 않은 계정" | admins 표에 이메일이 없음. `select public.signup_admin('이메일','비번','sonline');` 실행 또는 다른 관리자가 교사 계정 탭에서 추가 |
| 관리자 로그인 시 "Email not confirmed" | Authentication → Email → Confirm email 끄기. 또는 가입 코드로 계정을 다시 만들기(이미 있는 이메일이면 관리자 등록만 됨) |
| 이미지 업로드 실패 | 파일당 10MB 이하, PNG/JPG/WEBP/GIF 만 가능. Storage 에 `artworks` 버킷이 있는지 확인 |
| CSV 를 엑셀로 열었더니 글자가 깨짐 | 이 사이트가 만든 CSV 는 BOM 포함이라 정상. 직접 만든 작품정보.csv 는 엑셀에서 "CSV UTF-8" 로 저장 |
| 작품정보.csv 자동 매칭이 안 됨 | 파일명키워드 열이 파일 이름에 포함돼야 함(대소문자 무시). 드롭다운에서 수동 선택 가능 |
| 투표 마감했는데 학생 화면이 그대로 | 30초마다 자동 갱신됨. 새로고침하면 즉시 반영 |
| 학생이 "로그인이 필요합니다" 를 봄 | 같은 학교·학번·이름으로 다른 기기에서 다시 로그인한 경우. 마지막에 로그인한 기기만 투표 가능 |
| schema.sql 실행 중 오류 | 오류 줄의 메시지를 그대로 복사해 두세요. 재실행은 안전합니다 |

### 자주 쓰는 SQL
```sql
-- 가입 코드 변경
update public.secrets set value = '새코드' where key = 'admin_signup_code';

-- 관리자 목록
select * from public.admins;

-- 하트 순위 바로 보기
select a.title, a.author, count(l.id) as likes
from public.artworks a left join public.likes l on l.artwork_id = a.id
group by a.id order by likes desc;

-- 투표 전부 초기화 (작품은 유지)
delete from public.likes; delete from public.comments; delete from public.students;
```
