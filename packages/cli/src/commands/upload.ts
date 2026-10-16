import path from 'node:path';
import type { CommonFlags } from '../context.js';
import { stdio, type Io } from '../io.js';
import { UserError } from '../user-error.js';
import { uploadConfig, uploadRun, uploadMessage } from '../hosted-upload.js';

export async function uploadCommand(flags: CommonFlags, io: Io = stdio): Promise<number> {
  const config = uploadConfig();
  if (!flags.run)
    throw new UserError('jux upload needs --run <directory> containing report.json.');
  const result = await uploadRun(
    path.resolve(flags.project ?? process.cwd(), flags.run),
    config,
  );
  if (flags.json) io.out(`${JSON.stringify(result)}\n`);
  else io.out(uploadMessage(result));
  return 0;
}
