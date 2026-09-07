import {
  createRuntimeLogger,
  type LogSink,
  type RuntimeLogger,
} from '@mikaelcedergren/cx-framework/server/logging';

let active: RuntimeLogger | undefined;

/** Product identity composition; schema, privacy, context and bounded transport are shared. */
export function configureWargrLogging(
  role: 'web' | 'jobs' | 'operator',
  environment: NodeJS.ProcessEnv = process.env,
  releaseId = 'source',
  sink?: LogSink,
): RuntimeLogger {
  const mode = environment['NODE_ENV'];
  const nodeEnvironment = mode === 'production' || mode === 'test' ? mode : 'development';
  active = createRuntimeLogger({
    ...(sink ? { sink } : {}),
    identity: {
      service: 'wargr',
      role,
      releaseId,
      pid: process.pid,
      environment: nodeEnvironment,
      executionScope: environment['CX_EXECUTION_SCOPE'] ?? nodeEnvironment,
    },
  });
  return active;
}

export const log: Pick<RuntimeLogger, 'emit'> = Object.freeze({
  emit(event) {
    return (active ?? configureWargrLogging('operator')).emit(event);
  },
});
