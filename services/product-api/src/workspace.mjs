import {executionPolicy} from '../../../dsh-workbench/core/execution-policy.js';
import { realpath, stat, lstat, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * Project workspace access.
 *
 * The browser never sends a filesystem path: the product resolves an indexed
 * artifact's relative path under the tenant's project directory and refuses
 * anything that escapes it (absolute paths, `..`, symlinks).
 */
export function createWorkspace({ root }) {
  const base = typeof root === 'string' && root !== '' ? resolve(root) : '';

  const failure = (code, message) => Object.assign(new Error(message), { code, status: code === 'not_found' ? 404 : 400 });

  /** @returns the real path of one project directory. */
  async function projectDir(projectId) {
    if (base === '') throw failure('capability_unavailable', '未配置项目工作区根目录');
    if (!/^[A-Za-z0-9_]+$/.test(projectId)) throw failure('validation','项目路径不合法');
    const directory = join(base, projectId);
    try {
      const realBase = await realpath(base);
      if ((await lstat(directory)).isSymbolicLink()) throw failure('validation','项目目录不可为符号链接');
      const real = await realpath(directory);
      if (!real.startsWith(realBase + sep)) throw failure('validation','项目目录越界');
      return real;
    } catch (error) {
      if (error.code === 'validation') throw error;
      throw failure('not_found', '项目工作区不存在');
    }
  }

  /** @returns the verified absolute path of one artifact inside the project. */
  async function resolveArtifact(projectId, relativePath) {
    const directory = await projectDir(projectId);
    if (typeof relativePath !== 'string' || relativePath.trim() === '') {
      throw failure('validation', '缺少文件路径');
    }
    const normalized = relativePath.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw failure('validation', '文件路径不合法');
    }
    const candidate = resolve(directory, normalized);
    if (candidate !== directory && !candidate.startsWith(directory + sep)) {
      throw failure('validation', '文件路径不合法');
    }
    let real;
    try {
      real = await realpath(candidate);
    } catch {
      throw failure('not_found', '文件不存在');
    }
    if (real !== directory && !real.startsWith(directory + sep)) {
      throw failure('validation', '文件路径不合法');
    }
    const info = await stat(real);
    if (!info.isFile()) throw failure('not_found', '文件不存在');
    return { path: real, size: info.size };
  }

  async function provisionProject(projectId){
    if(!base || !/^[A-Za-z0-9_]+$/.test(projectId))throw failure('validation','未配置安全工作区');
    await executionPolicy(base);
    const realBase=await realpath(base);if((await lstat(base)).isSymbolicLink())throw failure('validation','工作区根目录不可为符号链接');
    await mkdir(join(realBase,projectId),{mode:0o700});return projectDir(projectId);
  }
  return { configured: base !== '', projectDir, resolveArtifact,provisionProject };
}
