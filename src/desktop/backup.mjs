import { backupWorkspace, verifyBackup } from '../core/backup.ts';
const [command, source, destination] = process.argv.slice(2);
try {
  if (!source || !['create', 'verify'].includes(command) || (command === 'create' && !destination))
    throw Error('BACKUP_ARGUMENTS');
  const manifest =
    command === 'create' ? await backupWorkspace(source, destination) : await verifyBackup(source);
  console.log(
    JSON.stringify({ verified: true, files: manifest.files.length, createdAt: manifest.createdAt }),
  );
} catch (error) {
  console.error(error.code || 'BACKUP_FAILED');
  process.exitCode = 1;
}
