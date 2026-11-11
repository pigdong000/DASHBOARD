# 내 주식 대시보드

보유 종목과 수량을 입력하면 평가금액·손익·비중을 대시보드로 보여주고, 보유 종목의 뉴스·공시를 출처와 함께 모아 보는 시연용 웹앱입니다.
데이터는 [K Skill](https://github.com/NomaDamas/k-skill)을 기반으로 가져옵니다.

## 실행

Node.js 18 이상이 필요하고, 추가로 설치할 패키지는 없습니다.

```bash
node --use-system-ca server.js
```

브라우저에서 http://localhost:8000 을 엽니다.
`--use-system-ca`는 사내망 인증서 환경에서 필요합니다.

## 배포 (Vercel)

운영 주소: https://stock-dashboard-phi-gray-96.vercel.app

```bash
npx vercel deploy --prod
```

Vercel은 루트의 `server.js`를 진입점으로 인식해 모든 요청을 이 파일이 내보내는 처리 함수로 보냅니다. 인증키는 `.env` 대신 Vercel 프로젝트 환경변수(Settings → Environment Variables)에 넣습니다.

## 기능

- **대시보드**: 종목 검색 후 추가, 총 평가금액·전일대비·평가손익·수익률, 종목별 비중 도넛 차트, 보유 종목 표(수량·평단 수정과 삭제 가능)
- **정보 게시판**: 보유 종목의 DART 공시와 뉴스를 최신순으로 모아 보기. 글마다 출처(접수번호·원문 링크·언론사)와 근거(조회 API·조건·조회 시각)를 표시
- 보유 내역은 브라우저(localStorage)에만 저장

## 데이터 출처

| 항목 | K Skill | 키 |
|---|---|---|
| 종목 검색, KRX 일별 종가 | `korean-stock-search` (k-skill-proxy) | 필요 없음 |
| 뉴스 | `naver-news-search` (k-skill-proxy) | 필요 없음 |
| 공시 | `k-dart` (DART OpenAPI 직접 호출) | `API_K_DART` |
| 당일 현재가 (선택) | `toss-investment` (토스증권 Open API) | `TOSSINVEST_CLIENT_ID`, `TOSSINVEST_CLIENT_SECRET` |

키는 `.env.example`을 `.env`로 복사한 뒤 채웁니다. `.env`는 저장소에 올라가지 않습니다.

KRX 데이터는 당일 종가를 다음 영업일 오전에 공개합니다. 그래서 토스 키가 없으면 최근 영업일 종가로 표시되고, 화면에 기준일이 함께 나옵니다.

## 구조

- `index.html`: 화면 (외부 라이브러리 없음)
- `server.js`: 로컬 중계 서버. k-skill-proxy가 브라우저 직접 호출(CORS)을 허용하지 않아 이 서버를 거쳐 호출하고, DART·토스 키를 서버에서만 사용합니다.

KRX·DART 공식 데이터를 모아 보여줄 뿐이며 투자 조언이 아닙니다.
