import path from 'node:path';
import type { CommonFlags } from '../context.js';
import { stdio, type Io } from '../io.js';
import { UserError } from '../user-error.js';
import { uploadConfig, uploadRun, uploadMessage } from '../hosted-upload.js';

export async function uploadCommand(flags: CommonFlags, io: Io = stdio): Promise<number> {
  const config = uploadConfig();
  if (!flags.run)
    throw new UserError('jux upload needs --run <directory> containing report.json.');
  if (flags['recover-direct'] && flags['abandon-direct'] !== undefined)
    throw new UserError('--recover-direct and --abandon-direct are mutually exclusive.');
  if (flags['recover-direct']) {
    const result = await uploadRun(
      path.resolve(flags.project ?? process.cwd(), flags.run),
      config,
      (message) => io.err(message),
      { recoverOnly: true },
    );
    if (flags.json) io.out(`${JSON.stringify(result)}\n`);
    else {
      io.out(
        `jux: ${result.attempts.length} recoverable direct attempts in hosted run ${result.runId}\n`,
      );
      for (const attempt of result.attempts)
        io.out(
          `To permanently cancel this story in this hosted run: jux upload --run <directory> --abandon-direct ${attempt.storyIdSafe}:${attempt.attemptId}\n`,
        );
    }
    return 0;
  }
  if (flags['abandon-direct'] !== undefined) {
    const match =
      /^([a-f0-9]{24}):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
        flags['abandon-direct'],
      );
    if (!match)
      throw new UserError(
        '--abandon-direct needs <storyIdSafe>:<attemptId> from the service recovery instruction.',
      );
    const result = await uploadRun(
      path.resolve(flags.project ?? process.cwd(), flags.run),
      config,
      (message) => io.err(message),
      { storyIdSafe: match[1]!, attemptId: match[2]! },
    );
    io.err(
      'jux: this story is permanently abandoned in this hosted run; cleanup may still be pending. Capture a new run with jux run --upload to submit again.\n',
    );
    if (flags.json) io.out(`${JSON.stringify(result)}\n`);
    else io.out(`jux: abandoned ${result.storyIdSafe} in hosted run ${result.runId}\n`);
    return 0;
  }
  const result = await uploadRun(
    path.resolve(flags.project ?? process.cwd(), flags.run),
    config,
    (message) => io.err(message),
  );
  if (flags.json) io.out(`${JSON.stringify(result)}\n`);
  else io.out(uploadMessage(result));
  return 0;
}
