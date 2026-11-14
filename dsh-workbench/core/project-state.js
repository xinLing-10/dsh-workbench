import { STAGES } from './artifacts.js';

export function createProjectState() {
  return {
    version: 3,
    project: { name: '', goal: '', createdAt: '' },
    flow: 'new',
    round: 1,
    stage: STAGES[0],
    sessionId: '',
    specSessionId: '',
    stageSessions: { spec: '', design: '', build: '', verify: '', ship: '' },
    previewUrl: '',
    stageData: {
      spec: {
        input: '',
        sourceName: '',
        sourcePath: '',
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
      design: {
        mode: 'preset',
        preset: 'agent',
        gates: [
          { id: 'gate-1', text: '核心数据结构：字段、约束与索引', enabled: true },
          { id: 'gate-2', text: '关键接口：入参、出参与错误码', enabled: true },
          { id: 'gate-3', text: '关键交互流程：正常路径 + 空态/加载/错误', enabled: true },
          { id: 'gate-4', text: '权限与角色判断的位置', enabled: true },
          { id: 'gate-5', text: '数据迁移与向后兼容（如涉及）', enabled: true },
        ],
        frontend: '',
        backend: '',
        database: '',
        deployTarget: '',
        constraints: '',
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
      build: {
        confirmations: [
          { id: 'default-1', text: '核心数据流与模块接口已核对', done: false },
          { id: 'default-2', text: '关键交互流程已在项目预览中走通', done: false },
          { id: 'default-3', text: '启动文档 / 部署文档与实际一致', done: false },
        ],
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
      verify: {
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
        fixRounds: 0,
      },
      ship: {
        mode: 'none',
        host: '',
        port: '',
        user: '',
        path: '',
        method: 'rsync',
        deployRequested: false,
        deployStartedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
    },
    activity: [],
    updatedAt: '',
  };
}

const str=(value,fallback='')=>typeof value==='string'?value:fallback;
export function boardSummary(id, state, name) {
  const pending = STAGES.find(stage => !state.stageData[stage].confirmed);
  const stage = pending || 'ship';
  const title = str(state.project.name).trim() || str(name).trim() || str(state.project.goal).trim().split('\n')[0].slice(0, 80) || `未命名需求 · 第 ${state.round || 1} 轮`;
  return { id, name: title, goal: str(state.project.goal).slice(0, 2000),
    flow: state.flow === 'incremental' ? 'incremental' : 'new', round: state.round,
    stage, confirmed: STAGES.findIndex(key => !state.stageData[key].confirmed) < 0 ? STAGES.length : STAGES.indexOf(stage),
    stageStarted: Boolean(state.stageData[stage].startedAt),
    stages: Object.fromEntries(STAGES.map(key => [key, {
      confirmed: state.stageData[key].confirmed, needsReview: !!state.stageData[key].needsReview,
      startedAt: state.stageData[key].startedAt, confirmedAt: state.stageData[key].confirmedAt,
      sessionId: state.stageSessions?.[key] || (key === 'spec' ? state.specSessionId : state.sessionId) || '',
    }])), updatedAt: state.updatedAt || new Date().toISOString() };
}
