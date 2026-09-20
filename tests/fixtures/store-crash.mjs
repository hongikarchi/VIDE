import { Store } from '../../src/core/store.mjs';
const store = new Store(process.argv[2]);
const project = store.createProject('crash fixture');
const connection = store.registerConnection(project.id, { host: 'rhino', instanceId: 'crash-instance', documentId: 'crash-doc' });
const run = store.createRun(project.id, { goal: 'crash fixture', targets: [connection.id] });
const input = store.saveInput(project.id, { text: '저장 완료 입력', pins: [] });
store.enqueue(project.id, { id: 'in-flight', runId: run.id, connectionId: connection.id, revision: 1,
  kind: 'createCandidate', payload: {} });
store.lease(connection.id);
process.send({ projectId: project.id, inputId: input.id });
setInterval(() => {}, 1000);
