// The person's Rhino plugin registration must not point at a development build (PLAN-51 T-297).
// Runs at the end of `npm run verify`: a dev session whose real-host test left
// HKCU ... Plug-ins\<VIDE id>\PlugIn FileName on `.vide/build/...` cannot pass verify. Read only.
import { isDevBuild, readRegisteredPlugin } from '../../tests/integration/plugin-guard.mjs';

const name = await readRegisteredPlugin();
console.log(`Rhino plugin registration FileName: ${name ?? '(none)'}`);
if (isDevBuild(name)) {
  console.error(
    '개발 빌드(.vide/build)가 사용자 Rhino에 등록돼 있습니다. Rhino를 모두 닫고 설치 VIDE 설정에서 Rhino 커넥터를 다시 설치하세요(POST /api/v1/connectors/rhino8/install).',
  );
  process.exit(1);
}
