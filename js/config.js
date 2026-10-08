// =====================================================================
//  Supabase 연결 설정
// =====================================================================
//  - SUPABASE_URL      : Supabase 대시보드 → Project Settings → API → Project URL
//  - SUPABASE_ANON_KEY : 같은 화면의 "anon public" (publishable) 키
//
//  ※ anon 키는 브라우저에 공개되어도 괜찮도록 설계된 키입니다.
//     실제 보안은 DB 의 RLS 정책과 함수가 담당합니다. (supabase/schema.sql 참고)
//  ※ service_role / secret 키는 절대 여기에 넣지 마세요. GitHub Pages 는 코드가 전부 공개됩니다.
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://cpjwysimjobthaieenbs.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwand5c2ltam9idGhhaWVlbmJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MjMwNTksImV4cCI6MjEwNjk5OTA1OX0.VNeebr_OXg43J8eSMxt3emsvsfSMGLUVbGSCj0WmKdc',
  // 작품 이미지를 저장하는 Storage 버킷 이름 (schema.sql 에서 만든 것과 같아야 함)
  STORAGE_BUCKET: 'artworks',
};
