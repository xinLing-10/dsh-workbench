/**
 * Client half of the Product Development Workbench.
 *
 * One project-scoped surface, three registrations:
 *
 * - `sidebar.panellist` — the Workbench icon.
 * - `main` — the full five-stage workspace with project preview and document
 *   preview.
 * - `conversation.view` — a compact stage strip inside a conversation, so the
 *   native composer can be used for discussion without leaving the stage.
 *
 * The UI is deliberately a guide, not an autonomous agent: every stage action
 * injects a precise prompt into the selected stage's persistent Session, and every
 * gate is still a human click. The Host owns files and persistence; the Client
 * only reads/writes through the bounded routes documented in index.js.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'workbench';
    const STAGES = ['spec', 'design', 'build', 'verify', 'ship'];
    const STATE_URL = '/workbench/state';
    const ARTIFACTS_URL = '/workbench/artifacts';
    const REVIEW_URL = '/workbench/review';
    const KNOWLEDGE_URL = '/workbench/knowledge';
    const CONTEXT_URL = '/workbench/context';
    const REQUIREMENTS_URL = '/workbench/requirements';
    const ROUNDS_URL = '/workbench/rounds';
    const BOARDS_URL = '/workbench/boards';
    const LIBRARY_URL = '/workbench/library';
    const FILE_URL = '/workbench/file';
    const RAW_URL = '/workbench/raw';
    const UPLOAD_URL = '/workbench/upload';
    const DOCX_URL = '/workbench/docx';
    const PROBE_URL = '/workbench/probe';

    /** Documents each stage is expected to leave behind. */
    const DOCS = {
      spec: [
        { path: '需求分析阶段.md', label: '可预览稿', role: 'preview' },
        { path: '需求分析阶段.docx', label: 'Word 交付稿', role: 'word' },
        { path: '需求交接.md', label: '交接摘要', role: 'handoff' },
      ],
      design: [
        { path: '产品实现设计文档.md', label: '详细设计', role: 'design' },
        { path: '设计交接.md', label: '交接摘要', role: 'handoff' },
      ],
      build: [
        { path: '启动文档.md', label: '启动文档', role: 'run' },
        { path: '部署文档.md', label: '部署文档', role: 'deploy' },
        { path: '实现交接.md', label: '交接摘要', role: 'handoff' },
      ],
      verify: [
        { path: '测试案例.md', label: '测试案例', role: 'cases' },
        { path: '测试结果.md', label: '测试结果', role: 'result' },
        { path: '验收交接.md', label: '交接摘要', role: 'handoff' },
      ],
      ship: [{ path: '交付清单.md', label: '交付清单', role: 'checklist' }],
    };

    /**
     * The five people the workbench models. Each one owns one stage, has a
     * conversation, and works through its own queue in requirement order.
     */
    const STAGE_PERSONAS = {
      spec: { color: '#4f7cff', glyph: '产' },
      design: { color: '#8b5cf6', glyph: '设' },
      build: { color: '#12a05c', glyph: '开' },
      verify: { color: '#d97706', glyph: '测' },
      ship: { color: '#0891b2', glyph: '运' },
    };

    /** Generic professional knowledge injected into each persona's prompt. */
    const PERSONA_KNOWLEDGE = {
      spec: '需求分层、用户故事、验收标准、范围控制与优先级',
      design: '系统结构、数据建模、接口契约、交互状态与兼容性',
      build: '代码组织、错误处理、可测试性、增量交付与可回滚',
      verify: '等价类与边界值、回归策略、缺陷分级与复现步骤',
      ship: '发布流程、环境差异、监控告警、回滚与变更记录',
    };

    /** One agent per stage: each stage runs in its own Session with this preset. */
    const STAGE_PRESETS = {
      spec: 'spec-analyst',
      design: 'design-architect',
      build: 'implementer',
      verify: 'verifier',
      ship: 'release-manager',
    };

    /** Handoff document each stage leaves for the next agent. */
    const STAGE_HANDOFFS = {
      spec: '需求交接.md',
      design: '设计交接.md',
      build: '实现交接.md',
      verify: '验收交接.md',
    };

    /** Baseline document an incremental round produces before writing requirements. */
    const BASELINE_PATH = '现状基线.md';

    /** @returns the handoff document the previous stage produced, or ''. */
    function incomingHandoff(stage) {
      const index = STAGES.indexOf(stage);
      if (index <= 0) return '';
      return STAGE_HANDOFFS[STAGES[index - 1]] || '';
    }

    /** Documents that must exist before a stage may be confirmed. */
    const REQUIRED_DOCS = {
      spec: ['需求分析阶段.md'],
      design: ['产品实现设计文档.md'],
      build: ['启动文档.md', '部署文档.md'],
      verify: ['测试案例.md', '测试结果.md'],
      ship: ['交付清单.md'],
    };

    /**
     * Implementation points the person approves one by one during coding.
     * They are chosen in the design stage and enforced through the conversation,
     * not through a checkbox: each one blocks its own code until approved.
     */
    const DEFAULT_GATES = [
      '核心数据结构：字段、约束与索引',
      '关键接口：入参、出参与错误码',
      '关键交互流程：正常路径 + 空态/加载/错误',
      '权限与角色判断的位置',
      '数据迁移与向后兼容（如涉及）',
    ];

    /** @returns the localized label of one approval gate. */
    function gateLabelOf(gate, copy) {
      const position = DEFAULT_GATES.findIndex((_, index) => gate.id === `gate-${index + 1}`);
      if (position < 0) return gate.text;
      return [copy.design.gate1, copy.design.gate2, copy.design.gate3, copy.design.gate4, copy.design.gate5][position];
    }

    /** Build-time checkpoints the person is expected to inspect. */
    const DEFAULT_BUILD_CHECKS = [
      '核心数据流与模块接口已核对',
      '关键交互流程已在项目预览中走通',
      '启动文档 / 部署文档与实际一致',
    ];

    /**
     * Ready-made technical plans for the design stage.
     *
     * The person choosing here may not know what a "frontend" is, so each plan
     * states the stack, what it buys, what it costs and who it fits — and the
     * custom fields stay available for people who do know.
     */
    const PLAN_IDS = ['local', 'single', 'cloud', 'agent'];

    const DESIGN_PLANS = {
      zh: [
        {
          id: 'local',
          name: '纯前端本地版',
          tagline: '一个网页应用，数据存在你自己的浏览器里，不需要服务器',
          fields: {
            frontend: 'React / Vue（或纯 HTML + JS）',
            backend: '无',
            database: '浏览器 IndexedDB',
            deployTarget: '静态托管 / 本地直接打开',
          },
          pros: ['最快能用：通常 1–2 天出第一版', '零服务器成本，也不用买域名', '数据不出本机，隐私最好', '没有后端，就没有接口攻击面'],
          cons: ['换电脑、换浏览器看不到数据', '不能多人同时在线协作', '清浏览器缓存会丢数据，必须导出备份', '数据量很大或查询很复杂时会卡'],
          fit: '个人或 1–3 人小团队、单机使用、先验证想法',
          effort: '低',
          cost: '无',
        },
        {
          id: 'single',
          name: '轻量后端单机版',
          tagline: '一台机器跑服务，数据集中存成文件，局域网内多人可用',
          fields: {
            frontend: 'React / Vue',
            backend: 'Node.js（Express）或 Python（FastAPI）',
            database: 'SQLite 单文件数据库',
            deployTarget: 'Docker 或直接运行 node，一台机器',
          },
          pros: ['数据集中，多人共享同一份', 'SQLite 零运维，备份就是拷一个文件', '内网就能用，不依赖外部云', '以后要扩容，可平滑换成 PostgreSQL'],
          cons: ['需要一台常开的电脑或服务器', '要处理开机自启、日志与定期备份', '公网访问要配域名、HTTPS 与登录', '出问题需要有人重启服务'],
          fit: '5–30 人团队、内网共享、希望数据留在自己手里',
          effort: '中',
          cost: '低',
        },
        {
          id: 'cloud',
          name: '云端多用户版',
          tagline: '部署到公网，任何设备都能访问，支持账号与权限',
          fields: {
            frontend: 'React / Next.js',
            backend: 'Node.js 或 Python API',
            database: 'PostgreSQL / MySQL（托管）',
            deployTarget: 'Vercel + 托管数据库，或云服务器',
          },
          pros: ['任何设备、任何地点都能用', '可以做账号、角色与权限', '托管平台自带 HTTPS、备份与扩容', '适合对外提供服务'],
          cons: ['周期最长，前后端都要做', '有月度费用（数据库 + 托管）', '登录鉴权、权限与安全都要设计', '线上出问题会影响所有用户'],
          fit: '跨地域团队、需要账号体系、要给外部用户使用',
          effort: '高',
          cost: '中',
        },
        {
          id: 'agent',
          name: '不确定，让 agent 推荐',
          tagline: '先别选死：agent 会结合需求给出 2–3 个候选和取舍，你点头后再定',
          fields: { frontend: '', backend: '', database: '', deployTarget: '' },
          pros: ['不需要懂技术就能做决定', '先用非技术语言讲清取舍', '避免为了简单需求上复杂架构'],
          cons: ['要多一轮对话', '最终仍需要你在几个选项里点一次头'],
          fit: '第一次做产品、不确定规模、需求还在变化',
          effort: '—',
          cost: '—',
        },
      ],
      en: [
        {
          id: 'local',
          name: 'Browser-only app',
          tagline: 'One web app, data kept in the visitor’s own browser, no server',
          fields: {
            frontend: 'React / Vue (or plain HTML + JS)',
            backend: 'None',
            database: 'Browser IndexedDB',
            deployTarget: 'Static host / open the file directly',
          },
          pros: ['Fastest to first version: usually 1–2 days', 'No server or domain cost', 'Data never leaves the machine', 'No backend, so no API attack surface'],
          cons: ['Data is per browser, not per person', 'No real-time collaboration', 'Clearing site data loses everything; export is required', 'Slows down on very large data or complex queries'],
          fit: 'One person or a 1–3 person team, single machine, validating an idea',
          effort: 'Low',
          cost: 'None',
        },
        {
          id: 'single',
          name: 'Single-box server',
          tagline: 'One machine runs a small service, data lives in one file, the team shares it on the LAN',
          fields: {
            frontend: 'React / Vue',
            backend: 'Node.js (Express) or Python (FastAPI)',
            database: 'SQLite single file',
            deployTarget: 'Docker or plain node on one machine',
          },
          pros: ['One shared copy of the data', 'SQLite needs no operations; backup is one file', 'Works on the LAN without any cloud', 'Can move to PostgreSQL later'],
          cons: ['Needs an always-on machine', 'You must handle autostart, logs and backups', 'Public access needs domain, HTTPS and login', 'Someone must restart it when it fails'],
          fit: 'A 5–30 person team sharing data on the LAN',
          effort: 'Medium',
          cost: 'Low',
        },
        {
          id: 'cloud',
          name: 'Cloud multi-user',
          tagline: 'Published on the internet, reachable from any device, with accounts and permissions',
          fields: {
            frontend: 'React / Next.js',
            backend: 'Node.js or Python API',
            database: 'Managed PostgreSQL / MySQL',
            deployTarget: 'Vercel + managed database, or a cloud server',
          },
          pros: ['Any device, any location', 'Accounts, roles and permissions', 'Managed HTTPS, backups and scaling', 'Serves external users'],
          cons: ['Longest build: frontend and backend', 'Monthly cost for database and hosting', 'Auth, permissions and security must be designed', 'An outage affects every user'],
          fit: 'Distributed teams, account systems, external users',
          effort: 'High',
          cost: 'Medium',
        },
        {
          id: 'agent',
          name: 'Not sure — let the agent recommend',
          tagline: 'Do not lock it in yet: the agent compares 2–3 options in plain language, then you pick',
          fields: { frontend: '', backend: '', database: '', deployTarget: '' },
          pros: ['No technical knowledge needed to decide', 'Trade-offs explained in plain language', 'No over-engineering for a simple need'],
          cons: ['One extra conversation round', 'You still approve one of the options'],
          fit: 'First product, uncertain scale, still-changing requirements',
          effort: '—',
          cost: '—',
        },
      ],
    };

    /** @returns the plan's stack as labelled lines. */
    function planStackLines(plan, labels = { frontend: '前端', backend: '后端', database: '数据', deployTarget: '部署' }) {
      return ['frontend', 'backend', 'database', 'deployTarget']
        .map((key) => (plan.fields[key] ? `- ${labels[key]}：${plan.fields[key]}` : null))
        .filter(Boolean)
        .join('\n');
    }

    /** @returns the plan definitions for one locale. */
    function plansFor(localeId) {
      return DESIGN_PLANS[localeId] || DESIGN_PLANS.zh;
    }

    /** @returns one plan by id for one locale, or undefined. */
    function planById(localeId, id) {
      return plansFor(localeId).find((plan) => plan.id === id);
    }

    const TEXT = {
      en: {
        panel: 'Workbench',
        appTitle: 'Product development workbench',
        appSub: 'Requirements → design → build → verify → ship, with a human decision at every gate',
        progress: 'Progress',
        stageOf: (n, total) => `Stage ${n} of ${total}`,
        project: 'Project',
        projectFallback: 'Untitled project',
        projectName: 'Project name',
        projectGoal: 'What are we building, in one paragraph?',
        projectDir: 'Project directory',
        projectDirHint: 'Absolute path to the project. Documents, code and .dsh state live here.',
        chooseDir: 'Choose folder',
        apply: 'Apply',
        projectNamePlaceholder: 'e.g. Team retrospective board',
        projectGoalPlaceholder: 'Who is it for, what problem does it solve, and what does success look like?',
        saveProject: 'Save project',
        editProject: 'Project info',
        reset: 'New project',
        resetConfirm: 'Create a new board? The previous board, documents and approval history will be kept.',
        saved: 'Saved',
        saving: 'Saving…',
        localOnly: 'Local only',
        loadFailed: 'Could not read the project state; the page is running in memory.',
        noSession: 'No workbench conversation yet. Starting a stage creates one.',
        guideTitle: 'How this works',
        guide1: 'Tell us the idea or upload a requirement document',
        guide2: 'Review the analysis; ask the agent to change anything',
        guide3: 'Confirm each stage to unlock the next one',
        guide4: 'Preview documents and the running project at any time',
        activityTitle: 'Recent activity',
        activityEmpty: 'Nothing yet. Start with requirements.',
        stage: {
          spec: {
            short: 'Requirements',
            title: 'Requirements analysis',
            desc: 'Turn a fuzzy idea into a checkable agreement: users, scenarios, scope, non-goals and acceptance criteria.',
            output: '需求分析阶段.docx',
          },
          design: {
            short: 'Design',
            title: 'Detailed design',
            desc: 'Pick a technical approach — no technical knowledge needed — then settle the data structures, interfaces and interaction logic before code.',
            output: '产品实现设计文档.md',
          },
          build: {
            short: 'Build',
            title: 'Implementation',
            desc: 'Build the main path first, keep the run and deployment docs current, and pause for review at key implementation points.',
            output: 'Code + 启动文档.md + 部署文档.md',
          },
          verify: {
            short: 'Verify',
            title: 'Test & acceptance',
            desc: 'Write traceable test cases, run them locally, record real results, and fix only what you approve.',
            output: '测试案例.md + 测试结果.md',
          },
          ship: {
            short: 'Ship',
            title: 'Delivery',
            desc: 'Produce a release checklist, and deploy only when you provide server access and explicit authorization.',
            output: '交付清单.md',
          },
        },
        status: {
          todo: 'Not started',
          started: 'Started',
          review: 'Needs review',
          confirmed: 'Confirmed',
          needsReview: 'Needs review',
          running: 'Agent is working',
        },
        action: {
          start: 'Start this stage',
          continue: 'Continue with context',
          generate: 'Generate',
          regenerate: 'Regenerate',
          confirm: 'Confirm and continue',
          openSession: 'Open conversation',
          openPreview: 'Project preview',
          upload: 'Upload requirement file',
          chooseFile: 'Choose a .md, .txt or .docx file',
          save: 'Save',
          refresh: 'Refresh',
          copy: 'Copy path',
          copied: 'Copied',
          open: 'Open in new tab',
          add: 'Add',
          remove: 'Remove',
          send: 'Send',
          sendSteer: 'Interrupt & send',
          probe: 'Probe local services',
          generateDocx: 'Generate Word',
          back: 'Back',
          next: 'Next',
          dismiss: 'Got it',
          useCurrent: 'Use current conversation',
        },
        spec: {
          source: 'Requirement source',
          placeholder:
            'Paste the requirement, notes from a meeting, a rough idea, or a link. If you have no document, leave this empty and let the agent interview you.',
          uploadHint: 'Upload a .md, .txt or .docx document. It is stored under .dsh/uploads and read into the analysis prompt.',
          uploaded: 'Loaded document',
          analyze: 'Analyze requirements',
          interviewing: 'Start with an interview',
          clarify: 'Clarification happens in the conversation. The agent must ask before inventing scope.',
          confirmTitle: 'Sign off the requirements',
          confirmHint: 'Read 需求分析阶段.docx. If anything is wrong, use the modification box below first.',
          confirmCheck: 'I have read the requirements document and confirm the scope, non-goals and acceptance criteria.',
          notes: 'Confirmation note (optional)',
          noDoc: 'The requirements document has not been generated yet. Start the stage and let the agent write it.',
          promptPreview: 'See the exact prompt',
          uploadFailed: 'Upload failed',
          uploading: 'Reading file…',
          wordHint: 'The Word file is generated from the Markdown draft automatically when you confirm.',
        },
        design: {
          title: 'Choose a technical approach',
          sub: 'You do not need to know the technology: pick a ready-made plan and read what it buys and what it costs.',
          planTitle: 'Technical approach',
          planHint: 'Not sure? Keep “let the agent recommend” and it compares options in plain language first.',
          stack: 'Stack',
          pros: 'What you get',
          cons: 'What it costs',
          fit: 'Best for',
          effort: 'Effort',
          cost: 'Cost',
          selected: 'Selected',
          customToggle: 'I know the stack — set it myself',
          customSub: 'These values go straight into the design prompt.',
          customTitle: 'Custom technical preferences',
          backToPlans: 'Back to the ready-made plans',
          frontend: 'Frontend',
          backend: 'Backend',
          database: 'Data store',
          deploy: 'Deployment target',
          constraints: 'Constraints / preferences',
          constraintsPlaceholder: 'Existing stack, hosting limits, compliance, style guide, libraries to avoid…',
          constraintsHint: 'Used in both modes: anything the agent must respect.',
          generate: 'Generate detailed design',
          generateOptions: 'Ask the agent for options',
          confirmTitle: 'Sign off the design',
          confirmHint: 'Check data structures, interfaces and interaction logic before any implementation starts.',
          confirmCheck: 'I have reviewed the data structures, interfaces and key interaction logic in the design.',
          interviewHint: 'The agent explains trade-offs in plain language and stops before writing code.',
          gatesTitle: 'Points to approve before coding',
          gatesHint: 'Tick what you want confirmed one by one during implementation: the agent must ask you in the conversation and wait for approval before writing that code.',
          gatesNote: 'These go into the implementation prompt; the generic checklist in the build stage stays for the final self-check.',
          gateAdd: 'Add another (e.g. field order in the export)',
          gate1: 'Core data structures: fields, constraints, indexes',
          gate2: 'Key interfaces: inputs, outputs, error codes',
          gate3: 'Key interaction flows: happy path + empty/loading/error',
          gate4: 'Where permissions and roles are checked',
          gate5: 'Data migration and backward compatibility (if any)',
        },
        build: {
          title: 'Build in reviewable increments',
          hint: 'The agent is instructed to stop at important functions and interaction points. Check each one before marking it done.',
          start: 'Start implementation',
          checksTitle: 'Key implementation checkpoints',
          checksHint: 'Add the functions or interactions you personally want to verify.',
          gatesTitle: 'Approval points agreed in the design',
          gatesHint: 'The agent asks for each one in the conversation while coding; the checklist below stays for the final self-check.',
          gatesNone: 'The design stage agreed no approval points.',
          gatesAdjust: 'Adjust in the design stage',
          default1: 'Core data flow and module interfaces checked',
          default2: 'Key interaction flow walked through in the project preview',
          default3: 'Launch and deployment docs match the running project',
          itemPlaceholder: 'e.g. Export flow handles empty state and permission errors',
          confirmTitle: 'Sign off implementation',
          confirmHint: 'All checkpoints must be ticked, and the launch/deployment docs must exist.',
          confirmCheck: 'I have checked the key implementation points and the running project.',
          noPreview: 'Preview is not configured yet',
          preview: 'Project preview',
        },
        verify: {
          title: 'Test against acceptance criteria',
          hint: 'The agent writes traceable cases, runs them locally, and records the exact commands and outcomes. Failures are listed before any fix.',
          run: 'Run tests & write the report',
          fix: 'Request a fix plan',
          fixTitle: 'Fix after review',
          fixHint: 'This asks for a root-cause analysis and a proposed change only. No code is changed until you approve it.',
          confirmTitle: 'Accept the test result',
          confirmHint: 'Every acceptance criterion should be pass or explicitly accepted as a known limitation.',
          confirmCheck: 'I have reviewed the test cases and results; failures are fixed or accepted.',
        },
        ship: {
          title: 'Delivery and optional deployment',
          hint: 'Produce a release checklist first. Deployment only runs when you provide a server and authorize it.',
          generate: 'Generate delivery checklist',
          generateNone: 'Generate checklist (no deployment)',
          modeNone: 'No online deployment',
          noDeployNote: 'No online deployment: the checklist is still required — it records the “not deployed” decision, how to run it locally, and the optional path to go live later.',
          confirmNeeds: 'Closing the stage needs 交付清单.md. If it is missing, click “Generate checklist” above and let the agent write it first.',
          modeSSH: 'Deploy to a server',
          host: 'Host / IP',
          port: 'Port',
          user: 'SSH user',
          path: 'Target path',
          method: 'Method',
          auth: 'I have configured SSH access and authorize the agent to follow 部署文档.md to deploy. Passwords are never stored by this workbench.',
          deploy: 'Deploy now',
          deployWarn: 'The agent must use your existing SSH key or environment. Do not paste a password into the chat.',
          confirmTitle: 'Close the delivery',
          confirmHint: 'Tick after deployment is verified, or after choosing no online deployment.',
          confirmCheck: 'Deployment is complete and verified, or this delivery intentionally has no online deployment.',
          deployed: 'Deployment requested',
        },
        modify: {
          title: 'Insert a change',
          hint: 'This message is sent to the current stage conversation with the stage context attached.',
          placeholder: 'Anything to change, add or clarify? The agent will explain the impact first.',
          steer: 'Interrupt the current task and apply this now',
          sent: 'Change sent to the stage conversation.',
          empty: 'Write the change first.',
          quick: 'Quick notes',
          quick1: 'Do not write code yet; explain the options first.',
          quick2: 'This misses an important edge case.',
          quick3: 'Keep the current structure; change only this part.',
        },
        chat: {
          tab: 'Chat',
          title: 'Workbench conversation',
          hint: 'This is the live workbench conversation. Stage actions fill in the prompt; you can also write here directly.',
          scopeSpec: 'Requirements agent',
          scopeDelivery: 'Delivery agent',
          scopes: {
            spec: 'Requirements agent',
            design: 'Design agent',
            build: 'Implementation agent',
            verify: 'Verification agent',
            ship: 'Delivery agent',
          },
          scopeHint: 'Each stage runs in its own agent and conversation; state passes between them through handoff documents (需求交接.md, 设计交接.md, 实现交接.md, 验收交接.md).',
          openFull: 'Open this conversation in the full chat view',
          openFullShort: 'Full chat',
          emptyTitle: 'No conversation yet',
          emptyHint: 'Start a stage and the agent conversation appears here — reply without leaving the workbench.',
          connecting: 'Opening the workbench conversation…',
          unavailable: 'The workbench conversation is not available right now. Start a stage to create a new one.',
        },
        docs: {
          title: 'Documents',
          tab: 'Docs',
          projectTab: 'Project preview',
          previewTab: 'Preview',
          emptyTitle: 'No document yet',
          emptyHint: 'Start the stage. The document appears here as soon as the agent writes it.',
          missing: 'Not generated yet',
          wordPreview: 'Word document · text preview',
          pdfBadge: 'PDF · original layout',
          extra: 'Other document in the project root',
          unsupported: 'This file cannot be previewed here. Download it to open it.',
          libraryFailed: 'Could not list the project documents.',
          pdfLoading: 'Rendering the PDF…',
          pdfFailed: 'Could not render this PDF. Download it instead.',
          download: 'Download this document',
          downloadShort: 'Download',
          downloading: 'Saving…',
          copyPath: 'Copy path',
          updated: 'Updated',
          size: 'Size',
          loadError: 'Could not load this document.',
          stageHint: 'Documents are read from the project root. The preview refreshes automatically.',
          generateWord: 'Generate Word',
          generated: 'Word document generated.',
        },
        preview: {
          title: 'Project preview',
          url: 'Preview URL',
          urlPlaceholder: 'http://localhost:5173',
          hint: 'Start the app from the conversation, then enter its local URL. If the frame stays blank, the app may block embedding — open it in a new tab.',
          probing: 'Looking for a local service…',
          found: 'Found a local service.',
          notFound: 'No common local service answered. Start the app first or enter its URL.',
          blocked: 'The app may block embedding. Use “Open in new tab”.',
          desktop: 'Desktop',
          tablet: 'Tablet',
          mobile: 'Mobile',
          noUrl: 'Set a preview URL to see the running project here.',
          refresh: 'Reload frame',
        },
        toast: {
          sent: 'Prompt sent to the workbench conversation.',
          modified: 'Change sent.',
          confirmed: (stage) => `${stage} confirmed. Next stage unlocked.`,
          needDoc: (path) => `Missing ${path}. Finish the stage output first.`,
          needDocShip: (path) =>
            `Missing ${path}: click “Generate checklist” to have the agent write it. A no-deployment delivery still needs the checklist.`,
          needDocShipStarting:
            'No delivery checklist yet — I asked the agent to write it. Confirm again once it appears.',
          saveFailed: 'Could not save the workbench state.',
          opened: 'Opening the workbench conversation.',
          noSession: 'Start a stage first to create the workbench conversation.',
          docxFailed: 'Could not generate the Word document.',
          deployNeeds: 'Fill in host, user and target path, then tick the authorization box.',
          deployed: 'Deployment prompt sent.',
        },
        layout: {
          railHandle: 'Resize the stage column (drag; double-click or Home to reset; arrow keys to nudge)',
          dockHandle: 'Resize the right column (drag; double-click or Home to reset; arrow keys to nudge)',
        },
        flow: {
          fresh: 'Start from scratch',
          incremental: 'Add to an existing product',
          hint: 'Incremental mode makes the requirements agent read the existing code and write 现状基线.md (baseline) first; the design stage must include a change-impact analysis.',
          roundBadge: (n, incremental) => `Round ${n}${incremental ? ' · incremental' : ''}`,
          newRound: 'Start a new increment',
          newRoundConfirm:
            'Start a new increment? The previous board and its document history are kept; the new round starts unconfirmed.',
          newRoundDone: (path) =>
            path ? `Archived to ${path}; the new increment has started.` : 'The new increment has started.',
        },
        team: {
          roles: {
            spec: 'Product manager',
            design: 'Designer',
            build: 'Developer',
            verify: 'QA engineer',
            ship: 'Ops engineer',
          },
          intros: {
            spec: 'Turns a vague idea into an acceptable requirement: interviews, scope, acceptance criteria.',
            design: 'Turns the requirement into structures and contracts you can build from.',
            build: 'Writes the code against the design and the approval gates, keeping every step runnable.',
            verify: 'Writes traceable test cases, runs them for real, and guards against regressions.',
            ship: 'Produces the release checklist, checks the docs, and owns deployment and rollback.',
          },
          open: 'Team',
          title: 'The team',
          sub: 'Five people, one per stage. Each of them keeps a queue: finish the requirement in hand, then pick the next one in line.',
          current: 'Now working on',
          idle: 'Idle — nothing queued',
          queue: 'My queue',
          waiting: 'Waiting upstream',
          next: 'Start task',
          talk: 'Talk',
          openBoard: 'Open board',
          autoNext: 'Start the next queued task automatically',
          autoNextHint: 'When a task is confirmed, the same person picks up the next one in line.',
          empty: 'No boards in this project yet. Fill in the project info and start the requirements stage.',
          started: 'Started',
          pending: 'Not started',
          nextStarted: (label) => `Picked up the next queued task: ${label}.`,
          noTask: 'This person has nothing queued right now.',
          stageTask: (stage, board) => `${board} · ${stage}`,
        },
        requirements: {
          openBoard: 'Requirement archive',
          title: 'Requirement archive',
          sub: 'One row per board (one requirement round): the stage it reached and what is confirmed, so closing the page or the session never strands a requirement.',
          emptyTitle: 'No requirement yet',
          empty: 'Fill in the project info and start the requirements stage; the archive records it automatically.',
          draft: 'Draft',
          inProgress: 'In progress',
          delivered: 'Delivered',
          stage: 'Stage',
          confirmed: 'confirmed',
          updated: 'Updated',
          open: 'Open',
          openSession: 'Open conversation',
          remove: 'Remove record',
          removeConfirm: 'Remove this record from the archive? Project files stay untouched.',
          removed: 'Record removed.',
          refresh: 'Refresh',
          back: 'Back to the board',
          gone: 'Directory missing',
          loadFailed: 'Could not read the requirement archive.',
          count: (n) => `${n} requirement${n === 1 ? '' : 's'}`,
          opened: (label) => `Opened ${label}.`,
        },
        view: {
          hint: 'The composer below is for discussion. Use the stage action to send the full stage context.',
          full: 'Open the full workbench for documents and project preview.',
          openFull: 'Full workbench',
        },
      },
      zh: {
        panel: '工作台',
        appTitle: '产品开发工作台',
        appSub: '需求 → 设计 → 实现 → 验证 → 交付，每个阶段都由你确认后再前进',
        progress: '总进度',
        stageOf: (n, total) => `阶段 ${n} / ${total}`,
        project: '项目',
        projectFallback: '未命名项目',
        projectName: '项目名称',
        projectGoal: '用一段话说明要做什么',
        projectDir: '项目目录',
        projectDirHint: '项目所在的绝对路径。文档、代码与 .dsh 状态都会放在这里。',
        chooseDir: '选择目录',
        apply: '应用',
        projectNamePlaceholder: '例如：团队复盘看板',
        projectGoalPlaceholder: '给谁用、解决什么问题、做成什么样算成功？',
        saveProject: '保存项目',
        editProject: '项目信息',
        reset: '新建项目',
        resetConfirm: '新建一块看板？原看板、文档和确认历史都会保留。',
        saved: '已保存',
        saving: '保存中…',
        localOnly: '仅保存在页面',
        loadFailed: '读取项目状态失败，当前页面在内存中继续工作。',
        noSession: '还没有工作台会话。开始任一阶段会自动创建。',
        guideTitle: '使用方式',
        guide1: '说出想法，或上传需求文稿',
        guide2: '查看分析结果，随时让 agent 修改',
        guide3: '逐阶段确认，确认后才解锁下一步',
        guide4: '随时预览文档和运行中的项目',
        activityTitle: '最近动态',
        activityEmpty: '还没有记录，从需求开始。',
        stage: {
          spec: {
            short: '需求',
            title: '需求分析',
            desc: '把模糊想法变成可核对的约定：目标用户、场景、范围、非目标与验收标准。',
            output: '需求分析阶段.docx',
          },
          design: {
            short: '设计',
            title: '详细设计',
            desc: '先选一个技术方案（不懂技术也没关系），再定数据结构、接口与交互逻辑，最后才写代码。',
            output: '产品实现设计文档.md',
          },
          build: {
            short: '实现',
            title: '编码实现',
            desc: '先跑通主路径，持续更新启动与部署文档，并在关键实现点停下来让你检查。',
            output: '项目代码 + 启动文档.md + 部署文档.md',
          },
          verify: {
            short: '验证',
            title: '测试验收',
            desc: '写可追溯的测试案例，本地真实执行并记录结果，只有你确认后才修改代码。',
            output: '测试案例.md + 测试结果.md',
          },
          ship: {
            short: '交付',
            title: '交付上线',
            desc: '生成交付清单；只有你提供服务器信息并明确授权时才执行线上部署。',
            output: '交付清单.md',
          },
        },
        status: {
          todo: '未开始',
          started: '已启动',
          review: '待确认',
          confirmed: '已确认',
          needsReview: '需重新审阅',
          running: 'Agent 正在执行',
        },
        action: {
          start: '开始这一阶段',
          continue: '带上下文继续',
          generate: '生成',
          regenerate: '重新生成',
          confirm: '确认并进入下一步',
          openSession: '打开对话',
          openPreview: '项目预览',
          upload: '上传需求文稿',
          chooseFile: '选择 .md、.txt 或 .docx 文件',
          save: '保存',
          refresh: '刷新',
          copy: '复制路径',
          copied: '已复制',
          open: '新窗口打开',
          add: '添加',
          remove: '删除',
          send: '发送',
          sendSteer: '打断并插入',
          probe: '探测本地服务',
          generateDocx: '生成 Word',
          back: '上一步',
          next: '下一步',
          dismiss: '知道了',
          useCurrent: '使用当前会话',
        },
        spec: {
          source: '需求来源',
          placeholder: '粘贴需求、会议记录、粗略想法或链接。没有文稿也可以留空，让 agent 先访谈你。',
          uploadHint: '支持 .md、.txt、.docx。文件保存在 .dsh/uploads，并自动带入分析提示词。',
          uploaded: '已载入文稿',
          analyze: '分析需求',
          interviewing: '先访谈我',
          clarify: '模糊之处在对话中确认。信息不足时要求 agent 先提问，不要自行补全范围。',
          confirmTitle: '确认需求文档',
          confirmHint: '请阅读 需求分析阶段.docx。如有偏差，先用下方修改框让 agent 调整。',
          confirmCheck: '我已阅读需求文档，并确认目标、范围、非目标与验收标准。',
          notes: '确认备注（可选）',
          noDoc: '需求文档还没生成。开始阶段后让 agent 先完成文档。',
          promptPreview: '查看完整提示词',
          uploadFailed: '上传失败',
          uploading: '正在读取文件…',
          wordHint: '确认时系统会根据 Markdown 稿自动生成 Word 交付文件。',
        },
        design: {
          title: '选择技术方案',
          sub: '不懂技术也没关系：直接选一个现成方案，下面写清了能得到什么、要付什么代价。',
          planTitle: '技术方案',
          planHint: '拿不准就保留「让 agent 推荐」，它会先用非技术语言对比几个选项。',
          stack: '技术栈',
          pros: '优点',
          cons: '代价',
          fit: '适合',
          effort: '上手难度',
          cost: '成本',
          selected: '已选择',
          customToggle: '我是技术同学，自己填',
          customSub: '这些内容会原样带进设计提示词。',
          customTitle: '自定义技术偏好',
          backToPlans: '回到方案选择',
          frontend: '前端',
          backend: '后端',
          database: '数据存储',
          deploy: '部署目标',
          constraints: '约束 / 偏好',
          constraintsPlaceholder: '已有技术栈、部署限制、合规要求、代码规范、不想用的库……',
          constraintsHint: '两种模式都会带上：任何 agent 必须遵守的限制都写这里。',
          generate: '生成详细设计',
          generateOptions: '先让 agent 给方案',
          confirmTitle: '确认详细设计',
          confirmHint: '开始编码前，请检查数据结构、接口与关键交互逻辑。',
          confirmCheck: '我已检查设计中的数据结构、接口与关键交互逻辑。',
          interviewHint: 'agent 会用非技术语言说明取舍，写代码前一定先停下来等你确认。',
          gatesTitle: '编码前需要你确认的关键点',
          gatesHint: '勾选你希望在编码阶段逐项确认的内容：编码时 agent 每做一项，必须先在对话里征得你同意，才会写这批代码。',
          gatesNote: '这些点会写进编码阶段的提示词；编码页仍保留通用的实现检查清单，用于最后自查。',
          gateAdd: '再加一条（例如：导出文件的字段顺序）',
          gate1: '核心数据结构：字段、约束与索引',
          gate2: '关键接口：入参、出参与错误码',
          gate3: '关键交互流程：正常路径 + 空态/加载/错误',
          gate4: '权限与角色判断的位置',
          gate5: '数据迁移与向后兼容（如涉及）',
        },
        build: {
          title: '按可检查的增量实现',
          hint: 'Agent 会在关键函数与交互逻辑处停下来。逐项确认后再继续。',
          start: '开始编码实现',
          checksTitle: '关键实现确认清单',
          checksHint: '把你真正想亲自验证的功能或交互加进来。',
          gatesTitle: '设计阶段约定的确认点',
          gatesHint: '编码时 agent 会在对话里逐条向你确认；下面的清单是通用检查项，用于最后自查。',
          gatesNone: '详细设计阶段没有约定确认点。',
          gatesAdjust: '去详细设计调整',
          default1: '核心数据流与模块接口已核对',
          default2: '关键交互流程已在项目预览中走通',
          default3: '启动文档 / 部署文档与实际一致',
          itemPlaceholder: '例如：导出流程覆盖空状态与权限失败',
          confirmTitle: '确认实现完成',
          confirmHint: '所有检查项都要勾选，并且启动文档、部署文档已经存在。',
          confirmCheck: '我已检查关键实现点，并在运行中的项目里验证过。',
          noPreview: '还未配置预览',
          preview: '项目预览',
        },
        verify: {
          title: '按验收标准测试',
          hint: 'Agent 会写可追溯的测试案例，在本地执行，并记录真实命令与结果。发现问题先列出，不直接改。',
          run: '执行测试并生成报告',
          fix: '请求修复方案',
          fixTitle: '评估后修复',
          fixHint: '这里只要求根因分析与修复方案；你同意之后才会改代码。',
          confirmTitle: '验收测试结果',
          confirmHint: '每条验收标准应是通过，或明确接受为已知限制。',
          confirmCheck: '我已核对测试案例与结果；失败项已修复或明确接受。',
        },
        ship: {
          title: '交付与可选上线',
          hint: '先生成交付清单。只有你提供服务器并授权后，才执行部署。',
          generate: '生成交付清单',
          generateNone: '生成交付清单（不部署）',
          modeNone: '无需线上部署',
          noDeployNote: '本次不部署也要出清单：清单里会写清「本次不部署」的结论、本地启动方式，以及日后要上线时的可选路径。',
          confirmNeeds: '完成交付需要 `交付清单.md`；没有就点上方「生成交付清单」，让 agent 先补上。',
          modeSSH: '部署到服务器',
          host: '主机 / IP',
          port: '端口',
          user: 'SSH 用户',
          path: '目标路径',
          method: '方式',
          auth: '我确认 SSH 权限已配置，并授权 agent 按 部署文档.md 执行部署。工作台不会保存密码。',
          deploy: '执行线上部署',
          deployWarn: '使用现有 SSH key 或环境变量，不要把密码粘贴到对话里。',
          confirmTitle: '完成交付',
          confirmHint: '部署已验证，或本阶段明确选择不部署后勾选。',
          confirmCheck: '部署已完成并验证，或本次交付明确无需线上部署。',
          deployed: '已请求部署',
        },
        modify: {
          title: '插入修改意见',
          hint: '消息会带上当前阶段上下文，发送到工作台会话。',
          placeholder: '想改什么、补什么、哪里不清楚？agent 会先说明影响面。',
          steer: '打断当前任务，立即插入',
          sent: '修改意见已发送到阶段会话。',
          empty: '先写下修改意见。',
          quick: '快捷意见',
          quick1: '先别写代码，先讲清方案选项。',
          quick2: '这里漏了一个重要边界情况。',
          quick3: '保持现有结构，只改这一部分。',
        },
        chat: {
          tab: '对话',
          title: '工作台对话',
          hint: '这里就是工作台会话：阶段操作会自动填入提示词，你也可以直接在这里说话。',
          scopeSpec: '需求分析 agent',
          scopeDelivery: '交付 agent',
          scopes: {
            spec: '需求分析 agent',
            design: '设计 agent',
            build: '实现 agent',
            verify: '验收 agent',
            ship: '交付 agent',
          },
          scopeHint: '每个阶段都是独立的 agent 和会话，阶段之间通过交接文档传递状态（需求交接.md → 设计交接.md → 实现交接.md → 验收交接.md）。',
          openFull: '在完整对话界面中打开这个会话',
          openFullShort: '完整对话',
          emptyTitle: '还没有对话',
          emptyHint: '开始一个阶段后，agent 的对话会出现在这里，不用离开工作台就能回复。',
          connecting: '正在打开工作台对话…',
          unavailable: '工作台对话暂时不可用。开始一个阶段即可创建新的对话。',
        },
        docs: {
          title: '文档预览',
          tab: '文档',
          projectTab: '项目预览',
          previewTab: '预览',
          emptyTitle: '还没有文档',
          emptyHint: '开始阶段后，agent 一写入文件，这里就会出现。',
          missing: '尚未生成',
          wordPreview: 'Word 文档 · 文本预览',
          pdfBadge: 'PDF · 原始版式',
          extra: '项目根目录中的其他文档',
          unsupported: '这个文件无法在这里预览，请下载后打开。',
          libraryFailed: '文档列表读取失败。',
          pdfLoading: '正在渲染 PDF…',
          pdfFailed: 'PDF 渲染失败，请改为下载。',
          download: '下载这个文档',
          downloadShort: '下载',
          downloading: '保存中…',
          copyPath: '复制路径',
          updated: '更新于',
          size: '大小',
          loadError: '文档读取失败。',
          stageHint: '阶段文档从本轮独立目录读取，预览会自动刷新。',
          generateWord: '生成 Word',
          generated: 'Word 文档已生成。',
        },
        preview: {
          title: '项目预览',
          url: '预览地址',
          urlPlaceholder: 'http://localhost:5173',
          hint: '在会话里启动项目后填入本地地址。如果画面空白，可能是应用禁止被嵌入，请用新窗口打开。',
          probing: '正在探测本地服务…',
          found: '已找到本地服务。',
          notFound: '常见端口没有响应。先启动项目，或手动填写地址。',
          blocked: '应用可能禁止被嵌入，请使用「新窗口打开」。',
          desktop: '桌面',
          tablet: '平板',
          mobile: '手机',
          noUrl: '设置预览地址后，这里会显示运行中的项目。',
          refresh: '刷新画面',
        },
        toast: {
          sent: '提示词已发送到工作台会话。',
          modified: '修改意见已发送。',
          confirmed: (stage) => `${stage} 已确认，下一阶段已解锁。`,
          needDoc: (path) => `缺少 ${path}，请先完成本阶段产出。`,
          needDocShip: (path) => `还缺 ${path}：点上方「生成交付清单」让 agent 先补上（选择不部署也要出清单）。`,
          needDocShipStarting: '还没有交付清单，已让 agent 开始补；生成后再回来点确认。',
          saveFailed: '工作台状态保存失败。',
          opened: '正在打开工作台会话。',
          noSession: '先开始一个阶段，才会创建工作台会话。',
          docxFailed: 'Word 文档生成失败。',
          deployNeeds: '请填写主机、用户、目标路径，并勾选授权。',
          deployed: '部署提示词已发送。',
        },
        layout: {
          railHandle: '调整左侧阶段栏宽度（拖动；双击或 Home 复位；方向键微调）',
          dockHandle: '调整右侧栏宽度（拖动；双击或 Home 复位；方向键微调）',
        },
        flow: {
          fresh: '从零开始',
          incremental: '已有产品，做增量',
          hint: '增量模式下需求 agent 会先读现有代码并产出《现状基线.md》，再写本次新增/变更的需求；设计阶段必须给出变更影响分析。',
          roundBadge: (n, incremental) => `第 ${n} 轮${incremental ? ' · 增量' : ''}`,
          newRound: '开始新一轮增量',
          newRoundConfirm:
            '开启新一轮增量？原看板、文档和确认历史保留，新一轮从未确认状态开始。',
          newRoundDone: (path) => (path ? `已归档到 ${path}，新一轮已开始。` : '新一轮已开始。'),
        },
        team: {
          roles: {
            spec: '产品经理',
            design: '设计人员',
            build: '开发人员',
            verify: '测试人员',
            ship: '运维人员',
          },
          intros: {
            spec: '把模糊想法变成可验收的需求：访谈、定范围、写验收标准。',
            design: '把需求落到可实现的结构与接口上，先想清楚再动手。',
            build: '按设计和确认点写代码，保持每一步都能运行。',
            verify: '按验收标准写案例、跑真实结果，不让既有功能回归。',
            ship: '出交付清单、核对文档、负责上线步骤与回滚方案。',
          },
          open: '团队',
          title: '团队',
          sub: '五个角色各管一个阶段，每人有自己的一条队列：做完手上的需求，再看队列里的下一项。',
          current: '正在处理',
          idle: '空闲，队列里没有任务',
          queue: '我的队列',
          waiting: '等待前序阶段',
          next: '开始任务',
          talk: '对话',
          openBoard: '查看看板',
          autoNext: '完成后自动接续队列中的下一项',
          autoNextHint: '确认本项后，同一位角色会自动接下一项。',
          empty: '这个项目还没有看板。填好项目信息并开始需求分析。',
          started: '已启动',
          pending: '待开始',
          nextStarted: (label) => `已自动接续队列中的下一项：${label}。`,
          noTask: '这位角色当前没有排期任务。',
          stageTask: (stage, board) => `${board} · ${stage}`,
        },
        requirements: {
          openBoard: '需求档案',
          title: '需求档案',
          sub: '每块看板（每轮需求）记一条：走到哪个阶段、确认了几步；关闭页面或会话后，可以从这里回到任意一轮。',
          emptyTitle: '还没有需求记录',
          empty: '填好项目信息并开始需求分析后，这里会自动记录下来。',
          draft: '草稿',
          inProgress: '进行中',
          delivered: '已交付',
          stage: '阶段',
          confirmed: '已确认',
          needsReview: '需重新审阅',
          updated: '更新于',
          open: '打开',
          openSession: '打开会话',
          remove: '移除记录',
          removeConfirm: '从档案中移除这条记录？项目文件不会被删除。',
          removed: '记录已移除。',
          refresh: '刷新',
          back: '返回工作台',
          gone: '目录不存在',
          loadFailed: '需求档案读取失败。',
          count: (n) => `${n} 条需求`,
          opened: (label) => `已切换到「${label}」。`,
        },
        view: {
          hint: '下方输入框用于讨论。要启动阶段任务，请点上面的阶段操作，把完整上下文带进去。',
          full: '在完整工作台里查看文档与项目预览。',
          openFull: '完整工作台',
        },
      },
    };

    /** @returns the copy for a locale id, falling back to Chinese. */
    function copyFor(localeId) {
      const base = TEXT[localeId] || TEXT.zh;
      return { ...base, design: { ...base.design, plans: plansFor(localeId) } };
    }

    /** @returns a fresh, valid state object. */
    function emptyState() {
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
            gates: DEFAULT_GATES.map((text, index) => ({
              id: `gate-${index + 1}`,
              text,
              enabled: true,
            })),
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
            confirmations: DEFAULT_BUILD_CHECKS.map((text, index) => ({
              id: `default-${index + 1}`,
              text,
              done: false,
            })),
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

    /** @returns whether a value is a plain record. */
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /** @returns a string or a fallback. */
    function str(value, fallback = '') {
      return typeof value === 'string' ? value : fallback;
    }

    /** @returns a boolean or false. */
    function bool(value) {
      return value === true;
    }

    /** @returns a unique id for new checklist/activity entries. */
    function uid(prefix = 'id') {
      try {
        return `${prefix}-${crypto.randomUUID()}`;
      } catch (error) {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
    }

    /** @returns the state with missing nested keys filled in. */
    function normalizeState(raw) {
      const base = emptyState();
      if (!isRecord(raw)) return base;
      const data = isRecord(raw.stageData) ? raw.stageData : {};
      const stageData = {};
      for (const stage of STAGES) {
        stageData[stage] = { ...base.stageData[stage], ...(isRecord(data[stage]) ? data[stage] : {}) };
      }
      if (Array.isArray(stageData.build.confirmations)) {
        const seen = new Set();
        stageData.build.confirmations = stageData.build.confirmations
          .filter((item) => isRecord(item) && str(item.text).trim() !== '')
          .map((item) => ({
            id: str(item.id) || uid('check'),
            text: str(item.text).slice(0, 300),
            done: bool(item.done),
          }))
          .filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
      } else {
        stageData.build.confirmations = base.stageData.build.confirmations;
      }
      return {
        ...base,
        ...raw,
        project: { ...base.project, ...(isRecord(raw.project) ? raw.project : {}) },
        stage: STAGES.includes(raw.stage) ? raw.stage : base.stage,
        flow: raw.flow === 'incremental' ? 'incremental' : 'new',
        round: Math.min(
          999,
          Math.max(1, Number.isFinite(Number(raw.round)) ? Math.floor(Number(raw.round)) : 1),
        ),
        stageData,
        activity: Array.isArray(raw.activity) ? raw.activity.filter(isRecord).slice(-30) : [],
      };
    }

    const ROOT_STORAGE_KEY = 'dsh-workbench:project-root';

    /** @returns the remembered project directory, or an empty string. */
    function readRootPreference() {
      try {
        return typeof localStorage === 'undefined' ? '' : localStorage.getItem(ROOT_STORAGE_KEY) || '';
      } catch (error) {
        return '';
      }
    }

    /** Persist the project directory across reloads. */
    function writeRootPreference(root) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(ROOT_STORAGE_KEY, root);
      } catch (error) {
        /* A blocked storage area must not break the workbench. */
      }
    }

    /* ------------------------------------------------------------------
     * Column layout
     *
     * The page is three columns: the stage rail, the content column and the
     * dock (documents / preview / conversation). Both gaps are draggable and
     * the widths survive reloads; the inline CSS variables drive the grids so
     * a drag never re-renders the page mid-gesture.
     * ---------------------------------------------------------------- */

    const LAYOUT_STORAGE_KEY = 'dsh-workbench:columns';
    const LAYOUT_DEFAULT = { rail: 220, dock: 386 };
    const LAYOUT_LIMITS = {
      rail: { min: 168, max: 360, width: 320 },
      dock: { min: 300, max: 640, width: 360 },
    };

    /** @returns one width clamped to its layout limits. */
    function layoutWidth(value, limits, fallback) {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.round(Math.min(limits.max, Math.max(limits.min, number)));
    }

    /** @returns the remembered column widths, or the defaults. */
    function readLayoutPreference() {
      try {
        const raw = typeof localStorage === 'undefined' ? '' : localStorage.getItem(LAYOUT_STORAGE_KEY);
        if (!raw) return { ...LAYOUT_DEFAULT };
        const parsed = JSON.parse(raw);
        return {
          rail: layoutWidth(parsed.rail, LAYOUT_LIMITS.rail, LAYOUT_DEFAULT.rail),
          dock: layoutWidth(parsed.dock, LAYOUT_LIMITS.dock, LAYOUT_DEFAULT.dock),
        };
      } catch (error) {
        return { ...LAYOUT_DEFAULT };
      }
    }

    /** Persist the column widths across reloads. */
    function writeLayoutPreference(layout) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
        }
      } catch (error) {
        /* A blocked storage area must not break resizing. */
      }
    }

    /**
     * Shared project state.
     *
     * Hydration is one read; mutations are debounced writes. A failed write
     * leaves the in-memory board intact and changes the top-bar save status to
     * "local only", so a flaky route never blocks the workflow.
     */
    const workbenchStore = (() => {
      let state = emptyState();
      let root = readRootPreference();
      let rootChosen = root !== '';
      let meta = {
        phase: 'loading',
        projectRoot: root,
        projectName: '',
        save: 'idle',
        error: '',
        hydrated: false,
      };
      let saving = false;
      let savePromise = Promise.resolve();
      let dirty = false;
      let timer;
      const listeners = new Set();

      const notify = () => {
        for (const listener of listeners) listener();
      };

      const broadcast = (nextMeta) => {
        meta = { ...meta, ...nextMeta };
        notify();
      };

      const flush = () => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        if (saving) return savePromise.then(() => dirty ? flush() : undefined);
        if (!dirty) return Promise.resolve();
        if (typeof fetch !== 'function') return Promise.reject(new Error('Cannot save offline'));
        const submitted = state;
        const submittedRoot = root;
        saving = true;
        dirty = false;
        broadcast({ save: 'saving' });
        savePromise = fetch(STATE_URL, {
          method: 'PUT',
          headers: { 'content-type': 'application/json',
            ...(root ? { 'x-workbench-root': encodeURIComponent(root) } : {}),
            ...(state.boardId ? { 'x-workbench-board': state.boardId } : {}),
          },
          body: JSON.stringify(submitted),
        }).then(async (response) => {
          const payload = await readApiJson(response, STATE_URL);
          if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
          if (root === submittedRoot && state.boardId === submitted.boardId) {
            const stageData = { ...state.stageData };
            for (const stage of STAGES) {
              if (state.stageData[stage] === submitted.stageData[stage]) stageData[stage] = payload.stageData[stage];
            }
            state = { ...state, boardId: payload.boardId, artifactStorage: payload.artifactStorage, stateRevision: payload.stateRevision, stageData };
            broadcast({ save: 'saved', error: '' });
          }
        }).catch((error) => {
          dirty = true;
          broadcast({ save: 'local', error: String(error.message || error) });
          throw error;
        }).finally(() => { saving = false; });
        return savePromise.then(() => dirty ? flush() : undefined);
      };

      const schedule = () => {
        dirty = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          flush().catch(() => {});
        }, 320);
      };

      const commit = (next) => {
        state = next;
        notify();
        schedule();
      };

      return {
        flush,
        // Apply server invalidation without replacing unsaved form fields.
        applyReview: (payload) => {
          if (payload.boardId !== state.boardId) return;
          if (payload.state.stateRevision < (state.stateRevision || 0)) return;
          let changed = false;
          const stageData = { ...state.stageData };
          for (const stage of STAGES) {
            const server = payload.state.stageData[stage];
            const local = stageData[stage];
            if ((!server.confirmed && local.confirmed) || server.needsReview !== local.needsReview) {
              stageData[stage] = { ...local, confirmed: local.confirmed && server.confirmed,
                confirmedAt: server.confirmed ? local.confirmedAt : '', needsReview: server.needsReview,
                approvalId: server.approvalId, legacyConfirmation: server.legacyConfirmation };
              changed = true;
            }
          }
          if (changed) {
            const stateRevision = state.stateRevision === payload.state.reviewRevisionBase
              ? payload.state.stateRevision : state.stateRevision;
            state = { ...state, stageData, stateRevision }; notify();
          }
        },
        get: () => state,
        getMeta: () => meta,
        getRoot: () => root,
        isRootChosen: () => rootChosen,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        hydrate: async (force = false) => {
          if (meta.hydrated && force !== true) return;
          if (typeof fetch !== 'function') {
            broadcast({ phase: 'offline', hydrated: true, save: 'local' });
            return;
          }
          try {
            const response = await fetch(STATE_URL, {
              headers: {
                accept: 'application/json',
                ...(root ? { 'x-workbench-root': encodeURIComponent(root) } : {}),
              },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await readApiJson(response, STATE_URL);
            const projectRoot = str(data.projectRoot) || root;
            const projectName = str(data.projectName);
            if (projectRoot) {
              root = projectRoot;
              if (rootChosen) writeRootPreference(root);
            }
            state = normalizeState(data);
            broadcast({
              phase: 'ready',
              hydrated: true,
              projectRoot,
              projectName,
              save: 'saved',
              error: '',
            });
          } catch (error) {
            broadcast({
              phase: 'offline',
              hydrated: true,
              save: 'local',
              error: String((error && error.message) || error),
            });
          }
        },
        setRoot: async (value) => {
          const next = str(value).trim();
          if (next === '') return false;
          await flush();
          if (next === root) {
            await workbenchStore.hydrate(true);
            rootChosen = true;
            writeRootPreference(root);
            return true;
          }
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          dirty = false;
          root = next;
          rootChosen = true;
          writeRootPreference(root);
          state = emptyState();
          meta = { ...meta, phase: 'loading', hydrated: false, projectRoot: next, projectName: '', error: '' };
          notify();
          await workbenchStore.hydrate(true);
          return true;
        },
        setStage: (stage) => {
          if (!STAGES.includes(stage) || state.stage === stage) return;
          commit({ ...state, stage });
        },
        /** Switch between a greenfield board and an incremental round. */
        setFlow: (flow) => {
          const next = flow === 'incremental' ? 'incremental' : 'new';
          if (state.flow === next) return;
          commit({ ...state, flow: next });
        },
        /** Replace the in-memory board with one the Host already wrote. */
        adopt: (next) => {
          if (!isRecord(next)) return;
          state = normalizeState(next);
          broadcast({ phase: 'ready', hydrated: true, save: 'saved', error: '' });
        },
        patchProject: (patch) => {
          commit({ ...state, project: { ...state.project, ...patch } });
        },
        patchStage: (stage, patch) => {
          if (!STAGES.includes(stage)) return;
          commit({
            ...state,
            stageData: {
              ...state.stageData,
              [stage]: { ...state.stageData[stage], ...patch },
            },
          });
        },
        setBuildChecks: (items) => {
          commit({
            ...state,
            stageData: {
              ...state.stageData,
              build: { ...state.stageData.build, confirmations: items },
            },
          });
        },
        setSession: (sessionId) => {
          commit({ ...state, sessionId: str(sessionId) });
        },
        /** Record the Session that owns one stage. */
        setStageSession: (stage, sessionId) => {
          commit({ ...state, ...stageSessionPatch(state, stage, str(sessionId)) });
        },
        invalidateFrom: (stage) => {
          const start = STAGES.indexOf(stage);
          if (start < 0) return;
          let changed = false;
          const stageData = { ...state.stageData };
          for (let index = start; index < STAGES.length; index += 1) {
            const key = STAGES[index];
            if (stageData[key].confirmed) {
              stageData[key] = { ...stageData[key], confirmed: false, confirmedAt: '', needsReview: true };
              changed = true;
            }
          }
          if (changed) commit({ ...state, stageData });
        },
        setPreviewUrl: (previewUrl) => {
          commit({ ...state, previewUrl: str(previewUrl) });
        },
        addActivity: (text, kind = 'info') => {
          const entry = {
            id: uid('activity'),
            time: new Date().toISOString(),
            kind,
            text: String(text).slice(0, 500),
          };
          commit({ ...state, activity: [...state.activity, entry].slice(-30) });
        },
        reset: () => {
          commit({ ...emptyState(), project: { ...emptyState().project, createdAt: new Date().toISOString() } });
        },
      };
    })();

    /** Decode API responses without exposing empty-body JSON parser failures. */
    async function readApiJson(response, endpoint = '') {
      const route = (endpoint || response.url || '').split('?')[0];
      const label = route ? `（${route}）` : '';
      const status = response.status;
      if (status === 401) throw new Error(`DSH 登录已失效${label}，请重新连接或登录后重试。`);
      if (status === 403) throw new Error(`DSH 拒绝访问工作台接口${label}，请检查登录状态和连接地址。`);
      if (status === 404 || status === 405) {
        throw new Error(`工作台后端接口未就绪${label}（HTTP ${status}）。请重启 DSH Host（停止后重新运行 dsh web），并刷新页面以加载新版插件。`);
      }
      let payload;
      try { payload = await response.json(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error(`工作台接口返回空响应或无效 JSON${label}（HTTP ${status || '未知'}），请检查 DSH Host 日志；升级插件后请重启 Host 并刷新页面。`);
      }
      if (!response.ok) throw new Error(payload?.message || `工作台请求失败${label}（HTTP ${status || '未知'}）`);
      if (payload === null) throw new Error(`工作台接口返回无效数据${label}，请检查 DSH Host 日志。`);
      return payload;
    }

    /** Fetch a workbench route with the selected project directory attached. */
    function apiFetch(url, options = {}) {
      const headers = { ...(options.headers || {}) };
      const root = workbenchStore.getRoot();
      if (root) headers['x-workbench-root'] = encodeURIComponent(root);
      const boardId = workbenchStore.get().boardId;
      if (boardId) headers['x-workbench-board'] = boardId;
      return fetch(url, { ...options, headers });
    }

    /** Every workbench action gets a persisted, versioned context envelope before delivery. */
    async function sendContextPrompt(send, text, options = {}) {
      await workbenchStore.flush();
      const boardId = workbenchStore.get().boardId;
      const root = workbenchStore.getRoot();
      const response = await apiFetch(CONTEXT_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'build', stage: options.stage || workbenchStore.get().stage }),
      });
      const manifest = await readApiJson(response, CONTEXT_URL);
      if (typeof manifest.prompt !== 'string' || !manifest.prompt.trim()) throw new Error('阶段上下文缺少有效内容，已停止发送；请检查 DSH Host 日志。');
      if (workbenchStore.get().boardId !== boardId || workbenchStore.getRoot() !== root || manifest.boardId !== boardId) {
        throw new Error('看板已切换，已停止发送旧看板的任务');
      }
      return send(`${text}\n\n${manifest.prompt}\n【资料选择规则】任务中的文档读取要求只适用于本清单已选用来源；必要资料被排除或缺失时先说明缺口，不要自行补读。`, options);
    }

    /** Subscribe a component to the shared workbench store. */
    function useWorkbench() {
      const [, force] = React.useState(0);
      React.useEffect(() => workbenchStore.subscribe(() => force((n) => n + 1)), []);
      React.useEffect(() => {
        workbenchStore.hydrate();
      }, []);
      return { state: workbenchStore.get(), meta: workbenchStore.getMeta(), store: workbenchStore };
    }

    /** Subscribe to the active locale without re-registering dictionaries. */
    function useLocaleId(locale) {
      const subscribe = React.useCallback(
        (listener) => (locale && typeof locale.subscribe === 'function' ? locale.subscribe(listener) : () => {}),
        [locale],
      );
      const get = React.useCallback(
        () => (locale && typeof locale.getLocale === 'function' ? locale.getLocale().active : 'zh'),
        [locale],
      );
      return React.useSyncExternalStore(subscribe, get, get);
    }

    /** @returns whether a workbench Session is currently running. */
    function useRunning(useSessionStatus, sessionId) {
      if (typeof useSessionStatus !== 'function') return false;
      return useSessionStatus((snapshot) =>
        sessionId ? snapshot.get(sessionId)?.running === true : false,
      );
    }

    /** @returns the most recent Session directory, used as a first-run suggestion. */
    function useSuggestedRoot(useSessions) {
      if (typeof useSessions !== 'function') return '';
      return useSessions((list) => {
        for (const id of list.ids) {
          const cwd = list.byId[id]?.cwd;
          if (cwd) return cwd;
        }
        return '';
      });
    }

    /** @returns a reader for one project document. */
    /** @returns a rough document kind from its extension. */
    function kindOfPath(path) {
      const lower = String(path || '').toLowerCase();
      if (lower.endsWith('.pdf')) return 'pdf';
      if (lower.endsWith('.docx')) return 'docx';
      if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) return 'markdown';
      if (lower.endsWith('.txt')) return 'text';
      return 'binary';
    }

    /** @returns whether the text preview route can render this kind. */
    function isTextKind(kind) {
      return kind === 'markdown' || kind === 'text' || kind === 'docx' || kind === 'code' || kind === 'html';
    }

    function useDocument(path, refreshVersion, enabled = true) {
      const [doc, setDoc] = React.useState({ phase: 'idle', data: null, error: '', path: '' });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        if (!path || enabled === false) {
          setDoc({ phase: 'idle', data: null, error: '', path: '' });
          return undefined;
        }
        const controller = new AbortController();
        let alive = true;
        setDoc((current) =>
          current.path === path && current.data
            ? { ...current, phase: 'refreshing' }
            : { phase: 'loading', data: null, error: '', path },
        );
        apiFetch(`${FILE_URL}?path=${encodeURIComponent(path)}&soft=1`, {
          cache: 'no-store',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            if (response.status === 404) return { missing: true };
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return readApiJson(response);
          })
          .then((payload) => {
            if (!alive) return;
            if (payload && payload.missing) setDoc({ phase: 'missing', data: null, error: '', path });
            else setDoc({ phase: 'ready', data: payload, error: '', path });
          })
          .catch((error) => {
            if (!alive || error.name === 'AbortError') return;
            setDoc({ phase: 'error', data: null, error: String(error.message || error), path });
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [path, refreshVersion, tick, enabled]);
      React.useEffect(() => {
        if (!path || enabled === false) return undefined;
        const timer = setInterval(() => setTick((n) => n + 1), 10_000);
        return () => clearInterval(timer);
      }, [path, enabled]);
      return doc;
    }

    /**
     * Read the project-root document list. One request covers every expected
     * deliverable plus anything the agent named itself, and it polls so a file
     * written mid-turn shows up without a manual refresh.
     */
    function useDocumentLibrary(refreshVersion) {
      const [library, setLibrary] = React.useState({ phase: 'loading', files: [] });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        apiFetch(LIBRARY_URL, {
          cache: 'no-store',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return readApiJson(response);
          })
          .then((payload) => {
            if (!alive) return;
            setLibrary({ phase: 'ready', files: Array.isArray(payload.files) ? payload.files : [] });
          })
          .catch((error) => {
            if (!alive || error.name === 'AbortError') return;
            setLibrary((current) => ({ ...current, phase: 'error' }));
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [refreshVersion, tick]);
      React.useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 5_000);
        return () => clearInterval(timer);
      }, []);
      return library;
    }

    /**
     * Read the cross-project requirement archive. It is the user-level view over
     * every project board, so closing the page or the session never strands a
     * requirement that was already analysed.
     */
    function useRequirementIndex() {
      const [archive, setArchive] = React.useState({ phase: 'loading', items: [] });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        apiFetch(REQUIREMENTS_URL, {
          cache: 'no-store',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return readApiJson(response);
          })
          .then((payload) => {
            if (!alive) return;
            setArchive({ phase: 'ready', items: Array.isArray(payload.items) ? payload.items : [] });
          })
          .catch((error) => {
            if (!alive || error.name === 'AbortError') return;
            setArchive((current) => ({ ...current, phase: 'error' }));
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [tick]);
      const refresh = React.useCallback(() => setTick((n) => n + 1), []);
      return { phase: archive.phase, items: archive.items, refresh };
    }

    function requirementKey(item) { return JSON.stringify([str(item.root), str(item.boardId)]); }

    /** Remove only the exact selected archive rows; project files are never touched. */
    async function removeRequirementRecords(items) {
      const response = await apiFetch(REQUIREMENTS_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remove-many', items: items.map(item => ({ root: item.root, boardId: str(item.boardId) })) }),
      });
      const payload = await readApiJson(response, REQUIREMENTS_URL);
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      return payload;
    }

    /** Read the project's board roster: one row per requirement round. */
    function useBoardRoster(refreshKey) {
      const [roster, setRoster] = React.useState({ phase: 'loading', activeId: '', boards: [] });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        apiFetch(BOARDS_URL, {
          cache: 'no-store',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return readApiJson(response);
          })
          .then((payload) => {
            if (!alive) return;
            setRoster({
              phase: 'ready',
              activeId: str(payload.activeId),
              boards: Array.isArray(payload.boards) ? payload.boards : [],
            });
          })
          .catch((error) => {
            if (!alive || error.name === 'AbortError') return;
            setRoster((current) => ({ ...current, phase: 'error' }));
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [refreshKey, tick]);
      const refresh = React.useCallback(() => setTick((n) => n + 1), []);
      return { phase: roster.phase, activeId: roster.activeId, boards: roster.boards, refresh };
    }

    /** Read the roster once, for scheduling decisions. */
    async function fetchBoardRoster() {
      const response = await apiFetch(BOARDS_URL, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await readApiJson(response);
      return {
        activeId: str(payload.activeId),
        boards: Array.isArray(payload.boards) ? payload.boards : [],
      };
    }

    /**
     * @returns the boards one persona still has to work on, oldest requirement
     * first. A board with `confirmed === stageIndex` is ready for that persona;
     * a lower count means it is still upstream.
     */
    function personaQueue(roster, stageIndex) {
      return (roster.boards || [])
        .filter((board) => board.confirmed <= stageIndex)
        .sort(
          (left, right) =>
            (left.round || 1) - (right.round || 1) ||
            String(left.updatedAt || '').localeCompare(String(right.updatedAt || '')),
        );
    }

    /** @returns the board the persona works on now, or null when idle. */
    function personaCurrent(roster, stageIndex) {
      return personaQueue(roster, stageIndex).find((board) => board.confirmed === stageIndex) || null;
    }

    /** @returns how many ready tasks wait behind the current one for a persona. */
    function personaWaiting(roster, stageIndex, currentId) {
      return (roster.boards || []).filter(
        (board) => board.confirmed === stageIndex && board.id !== currentId,
      ).length;
    }

    function requirementName(state) {
      return str(state.project.name).trim() || str(state.project.goal).trim().split('\n')[0].slice(0, 80) || `未命名需求 · 第 ${state.round || 1} 轮`;
    }

    function stageGuidance(state, viewed, running) {
      const current = STAGES.find(key => !state.stageData[key].confirmed);
      if (!current) return { current: 'ship', phase: 'complete' };
      if (viewed !== current) return { current, phase: 'return' };
      if (running) return { current, phase: 'running' };
      const data = state.stageData[current];
      return { current, phase: data.needsReview ? 'review' : data.startedAt ? 'review' : 'start' };
    }

    function TaskGuide({ state, stage, running, busy, copy, localeId, onSelect, onStart, onReview, onQueue }) {
      const en = localeId === 'en';
      const guide = stageGuidance(state, stage, running);
      const index = STAGES.indexOf(guide.current);
      const title = copy.stage[guide.current].title;
      const labels = en ? {
        complete: 'All stages confirmed', return: `Return to current stage: ${title}`,
        running: 'View agent task queue', review: `Review and confirm ${title}`,
        start: `${index ? 'Start next stage' : 'Start requirement'}: ${title}`,
      } : {
        complete: '本需求全部阶段已确认', return: `返回当前阶段：${title}`,
        running: '查看 Agent 任务队列', review: `审阅并确认${title}`,
        start: `${index ? '开始下一阶段' : '开始需求'}：${title}`,
      };
      const action = () => {
        if (guide.phase === 'return') onSelect(guide.current);
        else if (guide.phase === 'start') onStart(guide.current);
        else if (guide.phase === 'review') onReview(guide.current);
        else if (guide.phase === 'running') onQueue();
      };
      const hint = en ? {
        start: 'Ready to start. No agent work begins until you choose Start.',
        review: 'Review the deliverables and confirm this version to unlock the next stage. A finished turn is not approval.',
        running: 'The agent is working. You can inspect its conversation and tasks.',
        return: 'You are viewing another stage. Current progress is based on confirmed deliverables.',
        complete: 'You can review the delivery documents or create another requirement.',
      } : {
        start: '前序确认已完成。点击开始后才会安排本阶段工作。',
        review: '请检查成果并确认这一版，才会解锁下一阶段；Agent 回合结束不等于确认通过。',
        running: 'Agent 正在处理当前需求，可查看会话与任务详情。',
        return: '你正在查看其他阶段；实际进度以已确认成果为准。',
        complete: '可以查看交付成果，或新建下一项需求。',
      };
      return h('section', { className: 'dshwb-taskGuide', 'aria-label': en ? 'Current requirement and next action' : '当前需求与下一步' }, [
        h('div', { key: 'body', className: 'dshwb-taskGuideBody' }, [
          h('strong', { key: 'name' }, requirementName(state)),
          h('div', { key: 'current' }, guide.phase === 'complete' ? labels.complete : `${en ? 'Current stage' : '当前阶段'} ${index + 1}/5 · ${title}`),
          h('p', { key: 'hint' }, hint[guide.phase]),
        ]),
        h('div', { key: 'actions', className: 'dshwb-taskGuideActions' }, [
          guide.phase !== 'complete' ? h(Button, { key: 'primary', kind: 'primary', disabled: !!busy, disabledReason: '正在处理当前操作，请完成后再试。', onClick: action }, labels[guide.phase]) : null,
          guide.phase === 'review' ? h(Button, { key: 'continue', kind: 'secondary', disabled: !!busy, disabledReason: '正在处理当前操作，请完成后再试。', onClick: () => onStart(guide.current) }, en ? 'Continue this stage' : '继续完善本阶段') : null,
          h(Button, { key: 'queue', kind: 'secondary', disabled: !!busy, disabledReason: '正在处理当前操作，请完成后再试。', onClick: onQueue }, en ? 'Team & task queues' : '团队与任务队列'),
        ]),
      ]);
    }

    /** Round avatar of one persona (artwork; theme tokens are not used here). */
    function PersonaAvatar({ stage, size = 40 }) {
      const persona = STAGE_PERSONAS[stage] || STAGE_PERSONAS.spec;
      return h(
        'span',
        {
          className: 'dshwb-avatar',
          style: { width: `${size}px`, height: `${size}px`, background: persona.color },
          'aria-hidden': true,
        },
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: Math.round(size * 0.62),
            height: Math.round(size * 0.62),
            fill: 'none',
            stroke: '#ffffff',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
          },
          h('circle', { cx: 12, cy: 8.5, r: 3.6 }),
          h('path', { d: 'M5 20c0-3.7 3.1-5.6 7-5.6s7 1.9 7 5.6' }),
        ),
      );
    }

    /** One persona card: who they are, what they hold, and how to reach them. */
    function PersonaCard({ stage, index, roster, copy, onTalk, onStart, onOpenBoard, onOpenSession, activeBoardId, localeId }) {
      const queue = personaQueue(roster, index);
      const current = queue.find((board) => board.confirmed === index) || null;
      const waiting = personaWaiting(roster, index, current ? current.id : '');
      const upstream = queue.filter((board) => board.confirmed < index).length;
      const started = Boolean(current && (current.stages?.[stage]?.startedAt || current.stageStarted));
      const en = localeId === 'en';
      return h('article', { className: 'dshwb-persona' + (current ? ' dshwb-personaBusy' : '') }, [
        h('header', { key: 'head', className: 'dshwb-personaHead' }, [
          h(PersonaAvatar, { key: 'avatar', stage, size: 42 }),
          h('div', { key: 'who', className: 'dshwb-personaWho' }, [
            h('strong', { key: 'name' }, copy.team.roles[stage]),
            h('span', { key: 'role' }, copy.stage[stage].title),
          ]),
          current
            ? h('span', { key: 'state', className: 'dshwb-personaState' },
                started ? copy.status.started : copy.team.pending)
            : h('span', { key: 'idle', className: 'dshwb-personaState dshwb-personaStateIdle' }, upstream ? copy.team.waiting : copy.team.idle),
        ]),
        h('p', { key: 'intro', className: 'dshwb-personaIntro' }, copy.team.intros[stage]),
        h('div', { key: 'task', className: 'dshwb-personaTask' }, current
          ? [
              h('span', { key: 'label' }, en ? 'Current requirement' : '当前需求'),
              h('strong', { key: 'title' }, current.name || (en ? 'Untitled requirement' : '未命名需求')),
              h('span', { key: 'stage' }, copy.stage[stage].title),
            ]
          : h('span', { key: 'idle', className: 'dshwb-personaIdle' }, upstream ? (en ? 'Tasks are waiting for upstream confirmation.' : '已有排期任务，等待前序阶段确认。') : copy.team.noTask)),
        h('div', { key: 'queue', className: 'dshwb-personaQueue' }, [
          h('span', { key: 'label' }, `${copy.team.queue} · ${queue.length} · ${en ? 'Unlocked' : '已解锁'} ${waiting + (current ? 1 : 0)}`),
          upstream > 0
            ? h('span', { key: 'wait', className: 'dshwb-personaWait' }, `${copy.team.waiting} · ${upstream}`)
            : null,
        ]),
        h('details', { key: 'details', className: 'dshwb-queueDetails' }, [
          h('summary', { key: 'summary' }, `${en ? 'View task queue' : '查看任务队列'} · ${queue.length}`),
          queue.length ? h('ol', { key: 'items' }, queue.map((board, position) => {
            const detail = board.stages?.[stage] || {};
            const ready = board.confirmed === index;
            const status = !ready ? (en ? 'Waiting for upstream confirmation' : '等待前序确认')
              : detail.needsReview ? (en ? 'Needs re-review' : '需要重新审阅')
              : detail.startedAt ? (en ? 'Started · inspect session for live status' : '已启动 · 实时状态见会话')
              : (en ? 'Ready to start' : '待开始');
            return h('li', { key: board.id }, h('details', null, [
              h('summary', { key: 'name' }, `${board.name || (en ? 'Untitled requirement' : '未命名需求')} · ${status}`),
              h('p', { key: 'goal' }, board.goal || (en ? 'No requirement description yet.' : '尚未填写需求说明。')),
              h('p', { key: 'progress' }, `${en ? 'Current stage' : '当前阶段'}：${copy.stage[board.stage]?.title || copy.stage.spec.title} · ${board.confirmed}/5 ${en ? 'confirmed' : '已确认'}`),
              h('p', { key: 'time' }, `${en ? 'Started at' : '开始时间'}：${formatTime(detail.startedAt, localeId) || '—'}`),
              h('p', { key: 'id', className: 'dshwb-hint' }, `${en ? 'Internal task ID' : '内部任务 ID'}：${board.id}`),
              h('p', { key: 'session', className: 'dshwb-hint' }, `${en ? 'Session ID' : '会话 ID'}：${detail.sessionId || '—'}`),
              h('div', { key: 'actions', className: 'dshwb-personaActions' }, [
                h(Button, { key: 'view', size: 'xs', onClick: () => onOpenBoard(stage, board.id) }, en ? 'View requirement' : '查看这项需求'),
                h(Button, { key: 'session', size: 'xs', disabled: !detail.sessionId, disabledReason: '请先开始这项任务，创建 Agent 会话后再查看。', onClick: () => onOpenSession(detail.sessionId) }, en ? 'Agent conversation & tasks' : '查看 Agent 会话与任务'),
                h(Button, { key: 'start', size: 'xs', disabled: !ready || !!detail.startedAt, disabledReason: !ready ? '请先确认这项需求的前序阶段文档。' : '这项任务已经开始，请通过「查看 Agent 会话与任务」继续处理。', onClick: () => onStart(stage, board.id) }, en ? 'Start this task' : '开始这项任务'),
              ]),
            ]));
          })) : h('p', { key: 'empty' }, copy.team.noTask),
        ]),
        h('div', { key: 'actions', className: 'dshwb-personaActions' }, [
          h(
            Button,
            { key: 'talk', kind: 'secondary', size: 'xs', disabled: !current, disabledReason: '当前角色还没有任务，请先创建需求并推进到该阶段。', onClick: () => onTalk(stage) },
            h(Icon, { name: 'chat', size: 12 }),
            copy.team.talk,
          ),
          h(
            Button,
            { key: 'start', kind: 'ghost', size: 'xs', disabled: !current || current.stageStarted, disabledReason: !current ? '当前角色还没有任务，请先创建需求并推进到该阶段。' : '当前阶段已经开始，请打开会话继续处理。', onClick: () => onStart(stage) },
            h(Icon, { name: 'play', size: 12 }),
            copy.team.next,
          ),
          h(
            Button,
            { key: 'open', kind: 'ghost', size: 'xs', disabled: !current, disabledReason: '当前角色还没有任务，请先创建需求并推进到该阶段。', onClick: () => onOpenBoard(stage) },
            copy.team.openBoard,
          ),
        ]),
      ]);
    }

    /** The team: five personas, each with its own queue. */
    function TeamPanel({ copy, roster, onTalk, onStart, onOpenBoard, onOpenSession, autoNext, onToggleAutoNext, activeBoardId, localeId }) {
      const boards = roster.boards || [];
      return h('section', { className: 'dshwb-team' }, [
        h(SectionHead, {
          key: 'head',
          icon: 'users',
          title: copy.team.title,
          desc: copy.team.sub,
          extra: h(Button, { size: 'xs', onClick: roster.refresh }, localeId === 'en' ? 'Refresh queues' : '刷新任务队列'),
        }),
        h('label', { key: 'auto', className: 'dshwb-teamAuto' }, [
          h('input', {
            key: 'cb',
            type: 'checkbox',
            checked: autoNext,
            onChange: (event) => onToggleAutoNext(event.target.checked),
          }),
          h('span', { key: 'text', className: 'dshwb-teamAutoText' }, copy.team.autoNext),
          h('span', { key: 'hint', className: 'dshwb-teamAutoHint' }, copy.team.autoNextHint),
        ]),
        boards.length === 0
          ? h(
              'div',
              { key: 'empty', className: 'dshwb-docEmpty' },
              h(Icon, { name: 'info', size: 20 }),
              copy.team.empty,
            )
          : h(
              'div',
              { key: 'grid', className: 'dshwb-teamGrid' },
              STAGES.map((stage, index) =>
                h(PersonaCard, {
                  key: stage,
                  stage,
                  index,
                  roster,
                  copy,
                  onTalk,
                  onStart,
                  onOpenBoard,
                  onOpenSession,
                  localeId,
                  activeBoardId,
                }),
              ),
            ),
      ]);
    }

    /** Save one project document through the Host: fetch bytes, then download. */
    async function saveDocument(path) {
      const response = await apiFetch(`${RAW_URL}?path=${encodeURIComponent(path)}&download=1`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = String(path).split('/').pop() || 'document';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    /** Read one project document for prompt injection; '' when absent. */
    async function readDocumentText(path, cap = 12_000) {
      if (!path) return '';
      try {
        const response = await apiFetch(`${FILE_URL}?path=${encodeURIComponent(path)}&soft=1`, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return '';
        const payload = await readApiJson(response);
        if (!payload || payload.missing || typeof payload.text !== 'string') return '';
        return payload.text.slice(0, cap);
      } catch (error) {
        return '';
      }
    }

    /** Render a PDF from its original bytes; blob URLs keep the root header working. */
    function PdfPreview({ path, copy }) {
      const [state, setState] = React.useState({ phase: 'loading', url: '', error: '' });
      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        let objectUrl = '';
        setState({ phase: 'loading', url: '', error: '' });
        apiFetch(`${RAW_URL}?path=${encodeURIComponent(path)}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.blob();
          })
          .then((blob) => {
            if (!alive) return;
            objectUrl = URL.createObjectURL(blob);
            setState({ phase: 'ready', url: objectUrl, error: '' });
          })
          .catch((error) => {
            if (!alive || error.name === 'AbortError') return;
            setState({ phase: 'error', url: '', error: String(error.message || error) });
          });
        return () => {
          alive = false;
          controller.abort();
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
      }, [path]);
      if (state.phase === 'loading') {
        return h(
          'div',
          { className: 'dshwb-docEmpty' },
          h('span', { className: 'dshwb-spinner', 'aria-hidden': true }),
          copy.docs.pdfLoading,
        );
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'dshwb-docEmpty dshwb-docEmptyError' },
          h(Icon, { name: 'info', size: 18 }),
          copy.docs.pdfFailed,
          h('code', null, state.error),
        );
      }
      return h('iframe', {
        className: 'dshwb-pdfFrame',
        src: state.url,
        title: path,
      });
    }

    /** @returns a small SVG icon. */
    function Icon({ name, size = 16 }) {
      const bind = {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' },
      };
      const paths = {
        spark: [
          h('path', { key: 'a', d: 'M10 2.5l1.3 4.2L15.5 8l-4.2 1.3L10 13.5 8.7 9.3 4.5 8l4.2-1.3L10 2.5z' }),
          h('path', { key: 'b', d: 'M15.5 13.5l.6 2 2 .6-2 .6-.6 2-.6-2-2-.6 2-.6.6-2z' }),
        ],
        doc: [
          h('path', { key: 'a', d: 'M6 2.5h5l4 4v11H6z' }),
          h('path', { key: 'b', d: 'M11 2.5v4h4' }),
          h('path', { key: 'c', d: 'M8 11h5M8 14h5' }),
        ],
        play: [h('path', { key: 'a', d: 'M7 4.5l8 5.5-8 5.5z' })],
        check: [h('path', { key: 'a', d: 'M4 10.5l3.2 3L16 5.5' })],
        lock: [
          h('rect', { key: 'a', x: 5, y: 8.5, width: 10, height: 8, rx: 1.5 }),
          h('path', { key: 'b', d: 'M7.5 8.5V6a2.5 2.5 0 015 0v2.5' }),
        ],
        refresh: [
          h('path', { key: 'a', d: 'M16 10a6 6 0 11-1.8-4.3' }),
          h('path', { key: 'b', d: 'M16 4v4h-4' }),
        ],
        external: [
          h('path', { key: 'a', d: 'M11 3h6v6' }),
          h('path', { key: 'b', d: 'M17 3l-7 7' }),
          h('path', { key: 'c', d: 'M15 12v5H3V5h5' }),
        ],
        upload: [
          h('path', { key: 'a', d: 'M10 13V3' }),
          h('path', { key: 'b', d: 'M6 7l4-4 4 4' }),
          h('path', { key: 'c', d: 'M3 13v4h14v-4' }),
        ],
        send: [
          h('path', { key: 'a', d: 'M3 10l14-7-4.5 14-3-5.5z' }),
          h('path', { key: 'b', d: 'M9.5 11.5L17 3' }),
        ],
        plus: [h('path', { key: 'a', d: 'M10 4v12M4 10h12' })],
        trash: [
          h('path', { key: 'a', d: 'M4 6h12' }),
          h('path', { key: 'b', d: 'M7 6V4h6v2M6 6l.7 11h6.6L14 6' }),
        ],
        copy: [
          h('rect', { key: 'a', x: 7, y: 7, width: 10, height: 10, rx: 1.5 }),
          h('path', { key: 'b', d: 'M13 7V4H3v10h4' }),
        ],
        download: [
          h('path', { key: 'a', d: 'M10 3v10' }),
          h('path', { key: 'b', d: 'M6 9l4 4 4-4' }),
          h('path', { key: 'c', d: 'M3 16h14' }),
        ],
        monitor: [
          h('rect', { key: 'a', x: 2.5, y: 3.5, width: 15, height: 10, rx: 1.5 }),
          h('path', { key: 'b', d: 'M7 17h6M10 13.5V17' }),
        ],
        chat: [h('path', { key: 'a', d: 'M3 4h14v9H9l-4 3v-3H3z' })],
        arrow: [h('path', { key: 'a', d: 'M4 10h12M11 5l5 5-5 5' })],
        chevron: [h('path', { key: 'a', d: 'M7 4l6 6-6 6' })],
        users: [
          h('circle', { key: 'a', cx: 7.5, cy: 7, r: 2.8 }),
          h('path', { key: 'b', d: 'M2.5 16.5c0-2.6 2.2-4 5-4s5 1.4 5 4' }),
          h('circle', { key: 'c', cx: 14, cy: 7.5, r: 2.2 }),
          h('path', { key: 'd', d: 'M12.6 12.6c.5-.1 1-.2 1.4-.2 2.4 0 4.2 1.2 4.2 3.6' }),
        ],
        info: [
          h('circle', { key: 'a', cx: 10, cy: 10, r: 7 }),
          h('path', { key: 'b', d: 'M10 9v5M10 6.5v.5' }),
        ],
        server: [
          h('rect', { key: 'a', x: 3, y: 3, width: 14, height: 6, rx: 1 }),
          h('rect', { key: 'b', x: 3, y: 11, width: 14, height: 6, rx: 1 }),
          h('path', { key: 'c', d: 'M6 6h.01M6 14h.01' }),
        ],
        close: [h('path', { key: 'a', d: 'M5 5l10 10M15 5L5 15' })],
        command: [
          h('path', { key: 'a', d: 'M7 3a2 2 0 012 2v10a2 2 0 11-2-2h10a2 2 0 11-2 2V5a2 2 0 112-2z' }),
        ],
      };
      return h('svg', bind, paths[name] || paths.info);
    }

    /** A tiny Markdown renderer for the subset agent documents use. */
    function renderInline(text, keyPrefix) {
      const parts = [];
      const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
      let last = 0;
      let match;
      let index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('`')) {
          parts.push(h('code', { key: `${keyPrefix}-c-${index}` }, token.slice(1, -1)));
        } else if (token.startsWith('**')) {
          parts.push(h('strong', { key: `${keyPrefix}-b-${index}` }, token.slice(2, -2)));
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          if (link) {
            const href = link[2];
            parts.push(
              h(
                'a',
                {
                  key: `${keyPrefix}-a-${index}`,
                  href,
                  target: href.startsWith('http') ? '_blank' : undefined,
                  rel: href.startsWith('http') ? 'noreferrer' : undefined,
                },
                link[1],
              ),
            );
          } else {
            parts.push(token);
          }
        }
        last = match.index + token.length;
        index += 1;
      }
      if (last < text.length) parts.push(text.slice(last));
      return parts;
    }

    /** Render Markdown as React nodes, without raw HTML injection. */
    function MarkdownView({ text, kind }) {
      if (!text) return null;
      if (kind === 'text' || kind === 'docx' || kind === 'code') {
        return h(
          'pre',
          { className: 'dshwb-plainDoc' + (kind === 'code' ? ' dshwb-codeDoc' : '') },
          text,
        );
      }
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const nodes = [];
      let index = 0;
      let list = null;
      let listType = '';
      let code = null;

      const flushList = () => {
        if (list !== null) {
          nodes.push(h(listType, { key: `list-${index}` }, list));
          list = null;
          listType = '';
        }
      };

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const fence = /^```/.exec(line.trim());
        if (fence) {
          if (code !== null) {
            nodes.push(
              h(
                'pre',
                { key: `code-${index}`, className: 'dshwb-codeBlock' },
                h('code', null, code.join('\n')),
              ),
            );
            code = null;
          } else {
            flushList();
            code = [];
          }
          index += 1;
          continue;
        }
        if (code !== null) {
          code.push(line);
          index += 1;
          continue;
        }
        if (line.trim() === '') {
          flushList();
          index += 1;
          continue;
        }
        const tableRow = /^\s*\|.*\|\s*$/.test(line);
        const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
          lines[lineIndex + 1] || '',
        );
        if (tableRow && tableSeparator) {
          flushList();
          const cells = (value) =>
            value
              .trim()
              .replace(/^\|/, '')
              .replace(/\|$/, '')
              .split('|')
              .map((cell) => cell.trim());
          const headers = cells(line);
          const rows = [];
          let cursor = lineIndex + 2;
          while (cursor < lines.length && /^\s*\|.*\|\s*$/.test(lines[cursor])) {
            rows.push(cells(lines[cursor]));
            cursor += 1;
          }
          nodes.push(
            h(
              'div',
              { key: `table-${index}`, className: 'dshwb-tableWrap' },
              h(
                'table',
                null,
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    headers.map((cell, cellIndex) =>
                      h('th', { key: `th-${cellIndex}` }, renderInline(cell, `th-${index}-${cellIndex}`)),
                    ),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  rows.map((row, rowIndex) =>
                    h(
                      'tr',
                      { key: `tr-${rowIndex}` },
                      headers.map((_, cellIndex) =>
                        h(
                          'td',
                          { key: `td-${cellIndex}` },
                          renderInline(row[cellIndex] || '', `td-${index}-${rowIndex}-${cellIndex}`),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          lineIndex = cursor - 1;
          index += 1;
          continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          flushList();
          const level = Math.min(6, heading[1].length + 1);
          nodes.push(
            h(`h${level}`, { key: `h-${index}` }, renderInline(heading[2], `h-${index}`)),
          );
          index += 1;
          continue;
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          flushList();
          nodes.push(h('hr', { key: `hr-${index}` }));
          index += 1;
          continue;
        }
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
          flushList();
          nodes.push(
            h('blockquote', { key: `q-${index}` }, renderInline(quote[1], `q-${index}`)),
          );
          index += 1;
          continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
          if (listType !== 'ul') flushList();
          listType = 'ul';
          if (list === null) list = [];
          list.push(h('li', { key: `li-${index}` }, renderInline(bullet[1], `li-${index}`)));
          index += 1;
          continue;
        }
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (numbered) {
          if (listType !== 'ol') flushList();
          listType = 'ol';
          if (list === null) list = [];
          list.push(h('li', { key: `li-${index}` }, renderInline(numbered[1], `li-${index}`)));
          index += 1;
          continue;
        }
        flushList();
        nodes.push(h('p', { key: `p-${index}` }, renderInline(line, `p-${index}`)));
        index += 1;
      }
      flushList();
      if (code !== null) {
        nodes.push(
          h('pre', { key: `code-${index}`, className: 'dshwb-codeBlock' }, h('code', null, code.join('\n'))),
        );
      }
      return h('div', { className: 'dshwb-markdown' }, nodes);
    }

    /** @returns a human-readable byte size. */
    function formatBytes(size) {
      if (!Number.isFinite(size)) return '';
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** @returns a localized short time. */
    function formatTime(iso, localeId) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat(localeId === 'en' ? 'en' : 'zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    }

    /** @returns the project name shown in headers. */
    function projectLabel(state, meta, copy) {
      return str(state.project.name).trim() || meta.projectName || copy.projectFallback;
    }

    /**
     * The Session that owns one stage.
     *
     * Requirements analysis runs in its own Session (and its own agent preset);
     * stages 2–5 share the delivery Session. Boards created before the split
     * only have `sessionId`, so a started requirements stage keeps using it.
     * @returns the Session id, or an empty string when the stage has none yet.
     */
    function sessionFor(state, stage) {
      const sessions = state.stageSessions;
      if (sessions && typeof sessions === 'object' && str(sessions[stage]) !== '') return sessions[stage];
      // Legacy boards: the requirements stage had its own Session, stages 2–5
      // shared one delivery Session.
      if (stage === 'spec') {
        if (state.specSessionId) return state.specSessionId;
        return state.stageData.spec.startedAt || state.stageData.spec.confirmed ? state.sessionId : '';
      }
      return state.sessionId;
    }

    /**
     * @returns the state patch that records one stage's Session. `sessionId`
     * and `specSessionId` stay mirrored so older readers and the requirement
     * archive keep working.
     */
    function stageSessionPatch(state, stage, sessionId) {
      const previous = state && state.stageSessions && typeof state.stageSessions === 'object' ? state.stageSessions : {};
      const patch = { stageSessions: { ...previous, [stage]: sessionId } };
      if (stage === 'spec') patch.specSessionId = sessionId;
      if (stage === 'design') patch.sessionId = sessionId;
      return patch;
    }

    /** @returns whether a stage's prerequisite is confirmed. */
    function isLocked(state, stage) {
      const index = STAGES.indexOf(stage);
      if (index <= 0) return false;
      return !state.stageData[STAGES[index - 1]].confirmed;
    }

    /** @returns the stage status key for chips and rail dots. */
    function stageStatus(state, stage) {
      const data = state.stageData[stage];
      if (data.needsReview) return 'review';
      if (data.confirmed) return 'confirmed';
      if (data.startedAt) return 'started';
      return 'todo';
    }

    /* ------------------------------------------------------------------
     * Prompt builders
     * ---------------------------------------------------------------- */

    /** @returns the shared context block for every stage prompt. */
    function projectContext(state) {
      const name = requirementName(state);
      const goal = str(state.project.goal).trim() || '（用户尚未填写项目目标）';
      const mode =
        state.flow === 'incremental'
          ? `【交付模式】在已有产品上做增量（第 ${state.round || 1} 轮）\n`
          : '';
      const directory = state.artifactStorage?.directory;
      const paths = Object.values(DOCS).flat().map((item) => item.path).concat(BASELINE_PATH);
      const storage = directory
        ? `【本轮文档目录】${directory}/documents/\n【文档路径约束】下文与角色设定中所有阶段文档名，都指本轮目录内的同名文件。正式文档与交接摘要只能写入本轮目录；不得读取其他轮次或根目录同名文档代替本轮输入。代码、README 与应用部署文件仍在项目原位置。\n${paths.map((path) => `- ${path} → ${directory}/documents/${path}`).join('\n')}\n`
        : '【文档路径】请先加载看板，获取本轮文档目录。\n';
      return `【需求名称】${name}\n【队列任务命名】todo_write 等任务清单的任务标题统一以“${name} · 具体工作”命名；内部 ID 仅用于关联，不得作为面向用户的任务名。\n【工作台插件只读】不得修改工作台插件本体的代码、文档或配置，也不得通过脚本和命令间接改写。遇到插件问题只报告，不能把修复插件当成本需求的编码任务。\n【项目】${name}\n【项目目标】${goal}\n${mode}【工作目录】当前项目根目录。\n${storage}`;
    }

    function knowledgeFormat(stage) {
      const rules = {
        spec: '在需求分析阶段.md 中用独立标题定义稳定编号：### FR-001 功能需求、### NFR-001 非功能需求、### AC-001 验收标准。每条 AC 正文写明关联的 FR/NFR 编号。',
        design: '在产品实现设计文档.md 中用 ### ADR-001 决策标题 定义设计决策；正文列出关联 FR/AC、选择、备选方案、理由和适用范围。',
        build: '在实现交接.md 中用 ### TASK-001 任务标题 定义实现任务，写明关联 ADR/AC、关键文件、实现状态与验证方式。',
        verify: '在测试案例.md 中用 ### TC-001 用例标题 定义用例并关联 AC；在测试结果.md 中用 ### EV-001 证据标题 定义证据并关联 TC/AC。证据分别写“命令：”“结果：通过/失败/未执行”“代码版本：”；未真实执行不能写通过。',
        ship: '沿用已有 FR/AC/ADR/TASK/TC/EV 编号，交付清单引用相关验收证据；不要为未执行的验证编造结果。',
      };
      return `【知识追溯格式】${rules[stage] || ''} 保留已有编号，修改内容时不要随意重新编号；编号引用不代表前序条目已经确认。\n`;
    }

    /** Build one stage kickoff prompt. */
    function buildStagePrompt(state, stage, extras = {}) {
      const context = projectContext(state) + knowledgeFormat(stage);
      const spec = state.stageData.spec;
      const design = state.stageData.design;
      const build = state.stageData.build;
      const verify = state.stageData.verify;
      const ship = state.stageData.ship;

      // Every stage runs in its own Session with its own agent, so the previous
      // stage's handoff document is the only thing carried across.
      const stageIndex = STAGES.indexOf(stage);
      const previousStage = stageIndex > 0 ? STAGES[stageIndex - 1] : '';
      const nextStage = stageIndex >= 0 && stageIndex < STAGES.length - 1 ? STAGES[stageIndex + 1] : '';
      const handoffBlock = previousStage
        ? `【交接说明】上一阶段由独立 agent 完成，你们不共享对话记忆。本次选用的交接、需求、决策和约束以附加的工作台上下文清单为准；未选用或缺失的资料不能臆测，信息不足时提问。\n`
        : '';
      const personaName = TEXT.zh.team.roles[stage];
      const personaBlock = `【你的角色】${personaName}（${TEXT.zh.stage[stage].title}）。你具备通用专业知识：${PERSONA_KNOWLEDGE[stage]}；可以主动提出更好的做法，但项目产出以文档与我的确认为准。
${
  extras.queue && extras.queue.waiting > 0
    ? `【你的排期】按先来后到：做完当前这一项就停下来把结果交给我，我会把队列里的下一项交给你；不要提前处理队列中的其他需求。\n`
    : ''
}`;
      const incremental = state.flow === 'incremental';
      const round = state.round || 1;
      const flowLine = incremental
        ? `【模式】在已有产品上做增量（第 ${round} 轮）。只做本次新增/变更，不重写或重构现有产品。\n`
        : '';
      const outgoingDoc = STAGE_HANDOFFS[stage] || '';
      const handoffOut = outgoingDoc
        ? `【交接要求】本阶段完成后必须写 \`${outgoingDoc}\`：给下一位「${TEXT.zh.stage[nextStage].title}」agent 的 1 页交接摘要。你们不共享对话记忆，这份文件是唯一交接。`
        : '';

      if (stage === 'spec') {
        const source = spec.input.trim();
        const sourceBlock = source
          ? `【用户提供的需求原文】\n"""\n${source.slice(0, 60_000)}\n"""\n`
          : '【用户尚未提供需求文稿】\n';
        const incrementalSpec = incremental
          ? `【增量口径】
- 先读现状：package.json / README / src 目录 / 现有测试，写出 \`现状基线.md\`（技术栈与版本、启动命令、模块地图、现有测试与覆盖范围、已知约束）。没有基线不要写需求文档。
- 功能需求与验收标准只描述本次新增或变更的内容；单列一节「不改变的部分（保护项）」，写清这次明确不动的东西。
- 验收标准里至少有一条是回归项（现有功能不得回退）。
`
          : '';
        return `${context}
【当前阶段】1/5 需求分析
${flowLine}${personaBlock}
${sourceBlock}${incrementalSpec}请按下面的顺序工作：
1. 先判断是否存在影响范围、目标用户或验收标准的关键歧义。若有，最多提出 5 个问题，等待我回答；此时不要生成最终文档，也不要假设。
2. 信息足够后，输出结构化需求分析：背景与问题、目标用户与场景、目标、功能需求（FR-*）、非功能需求（NFR-*）、边界与非目标、假设与依赖、风险、验收标准（AC-*，每条必须可验证）。
3. 把正式文档保存为 \`需求分析阶段.docx\`，同时保存内容相同的 \`需求分析阶段.md\` 供工作台预览。环境无法直接生成 docx 时至少完成 md，工作台会自动转换。
4. 另外写一份 \`需求交接.md\`：这是给下一位「设计 agent」的交接摘要，你们不共享对话记忆。用固定小标题写清：目标、用户与场景、范围与非目标、功能需求编号（FR-*）、验收标准（AC-*）、关键假设与开放问题。控制在 1 页以内，不要复制整份需求文档。
5. 完成后用简短摘要列出文件路径、关键假设和待确认项，然后停下来等我确认；不要进入详细设计，也不要写产品代码。

${source ? '' : '这次用户没有提供文稿。请先用对话方式访谈：目标用户、使用场景、核心问题、这一版必须做什么、明确不做什么、怎样算验收通过。一次最多问 5 个问题。'}
`;
      }

      if (stage === 'design') {
        const plan = planById('zh', design.preset);
        const custom = design.mode === 'custom';
        const agentRecommend = !custom && plan ? plan.id === 'agent' : false;
        const customStack = [
          ['前端', design.frontend],
          ['后端', design.backend],
          ['数据存储', design.database],
          ['部署目标', design.deployTarget],
        ].filter(([, value]) => str(value).trim() !== '');
        const constraints = design.constraints.trim() ? `【额外约束】\n${design.constraints.trim()}\n` : '';

        if (agentRecommend) {
          return `${context}
【当前阶段】2/5 详细设计
【已确认需求】需求分析阶段.docx（预览稿：需求分析阶段.md）
【用户选择】不确定技术方案，让我推荐
【用户身份】非技术同学，请全程用非技术语言沟通。
${handoffBlock}${constraints}
本轮只做选型，不要写设计文档、不要写代码：
1. 先读需求，判断规模：使用人数、是否多人协作、是否对外提供服务、数据敏感度、是否需要离线。
2. 用非技术语言给出 2–3 个候选方案（优先从「纯前端本地版 / 轻量后端单机版 / 云端多用户版」里挑），每个说清：技术栈、能带来什么、要付什么代价、适合谁。
3. 给出你的推荐与一句话理由，然后停下来等我选；不要替我假设。
4. 我选定之后再写 \`产品实现设计文档.md\`。
`;
        }

        const stackLines = plan && !custom ? planStackLines(plan) : '';
        const planBlock = custom
          ? `【用户身份】技术同学，自行指定了技术偏好
【用户技术偏好】
${customStack.length ? customStack.map(([label, value]) => `- ${label}：${str(value).trim()}`).join('\n') : '- 未指定，请先给出建议并说明取舍'}
`
          : `【用户选择的技术方案】${plan.name}
【方案说明】${plan.tagline}
${stackLines ? `【方案技术栈】\n${stackLines}\n` : ''}【已知代价】
${plan.cons.map((item) => `- ${item}`).join('\n')}
【适合场景】${plan.fit}
【用户身份】非技术同学，按这个方案推进；要更换方案时先用非技术语言解释取舍，由我决定。
`;

        const gateLines = (Array.isArray(design.gates) ? design.gates : [])
          .filter((gate) => gate.enabled)
          .map((gate) => `- ${gate.text}`)
          .join('\n');
        const gatesBlock = gateLines
          ? `【编码前会逐条确认的点】用户在编码阶段会逐项确认下列内容，请在设计文档里把它们写到可以实现的程度（字段与约束、接口契约、交互分支、权限位置）：\n${gateLines}\n`
          : '';

        const incrementalDesign = incremental
          ? `【变更影响分析】设计文档必须包含一节「变更影响分析」：受影响的模块与文件、接口兼容性（能否不改调用方）、数据迁移与向后兼容、回滚点；明确复用现有架构，不另起一套。\n`
          : '';

        const steps = custom
          ? `1. 在 \`产品实现设计文档.md\` 开头写一节「技术方案与取舍」：明确技术栈与关键依赖，说明取舍、风险与升级路径。
2. 如果需求与这些技术偏好冲突，先说明冲突与替代方案，等我决定；不要静默更换技术栈。
3. 设计系统结构、模块边界与职责。
4. 设计数据结构：实体、字段、类型、约束、索引/持久化与迁移策略。
5. 设计交互逻辑：页面/状态、关键用户流程、状态机、空态/加载/错误/权限分支。
6. 定义接口契约：函数签名、API 路由、请求/响应、错误码。
7. 说明安全、性能、可观测性与部署约束。
8. 显式标出与需求的偏差。
9. 完成后停下来等我确认；不要开始编码。`
          : `1. 在 \`产品实现设计文档.md\` 开头写一节「技术方案与取舍」：用非技术语言说明为什么用这个方案、它的代价是什么、以后想升级该怎么做。
2. 如果需求与所选方案明显冲突（例如需要多人实时协作却选了纯前端本地版），先停下来用非技术语言说明冲突与替代方案，等我决定；不要静默更换技术栈。
3. 设计系统结构、模块边界与职责。
4. 设计数据结构：实体、字段、类型、约束、索引/持久化与迁移策略。
5. 设计交互逻辑：页面/状态、关键用户流程、状态机、空态/加载/错误/权限分支。
6. 定义接口契约：函数签名、API 路由、请求/响应、错误码。
7. 说明安全、性能、可观测性与部署约束。
8. 显式标出与需求的偏差。
9. 完成后停下来等我确认；不要开始编码。

${handoffOut}
`;

        return `${context}
【当前阶段】2/5 详细设计
【已确认需求】需求分析阶段.docx（预览稿：需求分析阶段.md）
${handoffBlock}${flowLine}${personaBlock}${planBlock}${gatesBlock}${incrementalDesign}${constraints}
请先阅读需求文档，然后：
${steps}
`;
      }

      if (stage === 'build') {
        const checks = build.confirmations.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n');
        const gates = (Array.isArray(design.gates) ? design.gates : [])
          .filter((gate) => gate.enabled)
          .map((gate, index) => `${index + 1}. ${gate.text}`)
          .join('\n');
        return `${context}
【当前阶段】3/5 编码实现
【输入】需求分析阶段.md / 需求分析阶段.docx、产品实现设计文档.md
${handoffBlock}${flowLine}${personaBlock}${incremental ? '【改动边界】只改实现本次需求必需的文件，不重构无关代码、不改变公开接口的既有行为；每步保持项目可运行；跑现有测试并记录回归结果。\n' : ''}【编码前必须逐条确认的点】用户在设计阶段选定，未获确认不得实现：
${gates || '- 用户没有选定确认点'}
【通用检查清单】最后自查用
${checks || '- 由用户补充'}
请按设计开始实现：
0. 先处理上面的确认点：每次只提交一个点（或一组紧密相关的点），说明你打算怎么写（数据结构与约束、接口签名与错误码、交互分支、权限位置），然后停下来等我明确回复「同意」或「修改」。
   - 我同意之前不要写这批代码；我要求修改就按修改后的方案再确认一次。
   - 不能因为问过别的点就跳过这一项，也不能把「确认」当成通知：没有我的明确同意，就不要提交这部分实现。
   - 用提问而不是长报告；一次一个问题，选项要具体到「可以 / 需要改哪里」。
1. 先让主路径端到端跑通，再补细节；每一步都保持可运行。
2. 用 todo_write 维护任务清单，完成一项勾一项；确认点通过后，在对应项里记录「已确认」。
3. 在关键函数、数据结构与交互逻辑完成时停下来，说明改了什么、我应该怎么检查、影响哪些文件；等我确认后再继续。
4. 同步维护 \`启动文档.md\`（安装、启动、环境变量、常见问题）与 \`部署文档.md\`（构建、部署、验证、回滚）。
5. 不要顺手重构与本次目标无关的代码。每次修改后说明验证命令与结果。
6. 完成后告诉我怎么启动项目，以及我应该重点检查哪些交互。

${handoffOut}
`;
      }

      if (stage === 'verify') {
        return `${context}
【当前阶段】4/5 测试验收
【输入】需求分析阶段.md、产品实现设计文档.md、当前项目代码
${handoffBlock}${flowLine}${personaBlock}${incremental ? '【回归要求】除新增 AC 外，必须跑现有测试并记录回归结果；失败项要区分「新功能缺陷」与「既有功能回归」。\n' : ''}请：
1. 从验收标准（AC-*）出发，编写 \`测试案例.md\`：每条案例包含 ID、对应 AC、前置条件、步骤、预期结果、类型（正常/边界/失败/权限）。
2. 在本地执行测试，记录真实命令、输出摘要、通过/失败。不要伪造结果。
3. 把结果写入 \`测试结果.md\`，逐条映射 AC；失败项列出复现步骤与实际/预期差异。
4. 覆盖边界、失败路径与权限场景。
5. 发现失败先不要改代码，列出根因假设和修复建议，等我确认。
6. 最后给出总体结论：可验收 / 有条件验收 / 不可验收。

${handoffOut}
`;
      }

      if (stage === 'ship') {
        const target =
          ship.mode === 'ssh'
            ? `${ship.user || '（未填用户）'}@${ship.host || '（未填主机）'}${ship.path ? `:${ship.path}` : ''}（方式：${ship.method}）`
            : '';
        const decision =
          ship.mode === 'ssh'
            ? `【部署决定】本次计划上线到 ${target}。不要现在执行部署；只在清单里写清部署步骤、验证步骤与回滚方案。`
            : '【部署决定】本次明确不做线上部署。即使不部署，也必须产出 `交付清单.md`：把「部署步骤」一节写成「本次不部署」的结论，并说明本地启动 / 局域网可用的方式，以及日后想上线时的可选路径。';
        return `${context}
【当前阶段】5/5 交付上线
【输入】需求分析阶段.md、产品实现设计文档.md、测试案例.md、测试结果.md
${handoffBlock}${flowLine}${personaBlock}${incremental ? '【变更交付】交付清单按「本次增量」口径写：版本号升级、变更文件与功能说明（本次新增 vs 既有功能）、变更部署步骤、回滚方案；不要重写整份产品文档。\n' : ''}${decision}
请：
1. 必须生成 \`交付清单.md\`（工作台的「完成交付」以它为准）：版本号、变更文件、前置检查、构建/启动命令、部署步骤（或「本次不部署」的结论）、验证步骤、回滚方案、已知限制。
2. 核对 README、启动文档、部署文档与新代码一致。
3. 从干净环境按文档走一遍启动流程，记录结果。
4. 不要执行线上部署。需要上线时由我在工作台填服务器信息并单独授权；清单里只写步骤。
5. 完成后列出交付物路径和仍需人工处理的事项，并明确一句「交付清单已生成」。
`;
      }
      return context;
    }

    /** Build a mid-stage change prompt. */
    function buildModifyPrompt(state, stage, text) {
      const title = TEXT.zh.stage[stage].title;
      return `${projectContext(state)}
【当前阶段】${title}
【用户的中途修改意见】
"""
${text.trim().slice(0, 20_000)}
"""
请先说明这条意见会影响哪些文档、代码或验收标准，然后按当前阶段继续处理。若涉及关键范围变化，先向我确认；不要静默改需求。`;
    }

    /** Build the fix-plan prompt used by the verify stage. */
    function buildFixPrompt(state) {
      return `${projectContext(state)}
【当前阶段】测试修复评估
请阅读 \`测试结果.md\`：
1. 为每个失败项给出根因假设、影响面与最小修复方案。
2. 标出哪些修复会改变已确认需求或接口。
3. 列出建议的回归测试。
4. 先不要改代码，等我确认方案后再实施。
`;
    }

    /** Build the deployment prompt. Credentials are deliberately excluded. */
    function buildDeployPrompt(state) {
      const ship = state.stageData.ship;
      return `${projectContext(state)}
【当前阶段】线上部署（用户已明确授权）
【服务器】${ship.user}@${ship.host}:${ship.port || '22'}
【目标路径】${ship.path}
【部署方式】${ship.method}
请严格按 \`部署文档.md\` 执行部署：
1. 开始前复述将要执行的命令与可能的破坏性操作；如果与文档不一致，先停下来。
2. 使用现有 SSH key 或环境变量认证，不要向我索要明文密码，也不要把密钥写进仓库。
3. 部署后执行健康检查与关键路径验证，记录访问地址、命令和结果。
4. 如果部署失败，停止并给出回滚步骤，不要反复猜测重试。
5. 把实际部署结果追加到 \`交付清单.md\`。
`;
    }

    /* ------------------------------------------------------------------
     * Route helpers
     * ---------------------------------------------------------------- */

    /** @returns parsed document payload, or null when absent. */
    async function readDocument(path) {
      try {
        const response = await apiFetch(`${FILE_URL}?path=${encodeURIComponent(path)}&soft=1`, { cache: 'no-store' });
        if (!response.ok) return null;
        const payload = await readApiJson(response);
        return payload && payload.missing === true ? null : payload;
      } catch (error) {
        return null;
      }
    }

    /** Ensure the Word requirement deliverable exists. */
    async function ensureRequirementDocx() {
      const existing = await readDocument('需求分析阶段.docx');
      if (existing) return true;
      const source = await readDocument('需求分析阶段.md');
      if (!source) return false;
      const response = await apiFetch(DOCX_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: '需求分析阶段.md', target: '需求分析阶段.docx' }),
      });
      return response.ok ? 'generated' : false;
    }

    /** @returns whether every required document for a stage exists. */
    /**
     * @returns the documents one stage shows. Incremental rounds add the
     * baseline document the requirements agent must write first.
     */
    function stageDocs(state, stage) {
      const base = DOCS[stage] || [];
      if (
        stage === 'spec' &&
        state.flow === 'incremental' &&
        !base.some((item) => item.path === BASELINE_PATH)
      ) {
        return [{ path: BASELINE_PATH, label: '现状基线', role: 'baseline' }, ...base];
      }
      return base;
    }

    /** @returns the documents that must exist before a stage may be confirmed. */
    function requiredDocs(state, stage) {
      const base = REQUIRED_DOCS[stage] || [];
      if (stage === 'spec' && state.flow === 'incremental' && !base.includes(BASELINE_PATH)) {
        return [...base, BASELINE_PATH];
      }
      return base;
    }

    async function missingDocuments(state, stage) {
      const missing = [];
      for (const path of requiredDocs(state, stage)) {
        if ((await readDocument(path)) === null) missing.push(path);
      }
      return missing;
    }

    /** Copy text without throwing when the clipboard is unavailable. */
    function copyText(text) {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve(false);
      try {
        const result = clipboard.writeText(text);
        return result && typeof result.then === 'function'
          ? result.then(
              () => true,
              () => false,
            )
          : Promise.resolve(true);
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    /* ------------------------------------------------------------------
     * Small presentation components
     * ---------------------------------------------------------------- */

    // Disabled actions remain focusable so pointer and keyboard users can learn why.
    const disabledToastListeners = new Set();
    function notifyDisabled(reason) {
      for (const show of disabledToastListeners) show(reason, 'hint');
    }
    function Button({ children, kind = 'secondary', size = 'md', disabled, disabledReason, onClick, title, type = 'button', className, ...rest }) {
      const unavailable = Boolean(disabled);
      const reason = disabledReason || '此功能暂不可用，请先完成当前操作后再试。';
      return h('button', {
        ...rest,
        type: unavailable ? 'button' : type,
        className: className || `dshwb-btn dshwb-btn-${kind} dshwb-btn-${size}`,
        'aria-disabled': unavailable ? true : undefined,
        title: unavailable ? reason : title,
        onClick: event => {
          if (unavailable) {
            event.preventDefault(); event.stopPropagation(); notifyDisabled(reason); return;
          }
          if (onClick) return onClick(event);
        },
      }, children);
    }

    function StatusPill({ status, copy }) {
      const labels = {
        todo: copy.status.todo,
        started: copy.status.started,
        review: copy.status.needsReview,
        confirmed: copy.status.confirmed,
        running: copy.status.running,
      };
      return h(
        'span',
        { className: `dshwb-status dshwb-status-${status}` },
        h('span', { className: 'dshwb-statusDot', 'aria-hidden': true }),
        labels[status] || labels.todo,
      );
    }

    function Card({ children, className = '' }) {
      return h('section', { className: `dshwb-card ${className}`.trim() }, children);
    }

    function SectionHead({ icon, title, desc, extra }) {
      return h('div', { className: 'dshwb-sectionHead' }, [
        h('span', { key: 'icon', className: 'dshwb-sectionIcon' }, h(Icon, { name: icon, size: 18 })),
        h('div', { key: 'text', className: 'dshwb-sectionText' }, [
          h('h3', { key: 'title', className: 'dshwb-sectionTitle' }, title),
          desc ? h('p', { key: 'desc', className: 'dshwb-sectionDesc' }, desc) : null,
        ]),
        extra ? h('div', { key: 'extra', className: 'dshwb-sectionExtra' }, extra) : null,
      ]);
    }

    function CheckRow({ checked, onChange, children, disabled }) {
      return h(
        'label',
        { className: 'dshwb-checkRow' + (checked ? ' dshwb-checkRowOn' : '') },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'dshwb-checkBox', 'aria-hidden': true }, checked ? h(Icon, { name: 'check', size: 12 }) : null),
        h('span', { className: 'dshwb-checkLabel' }, children),
      );
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'dshwb-field' }, [
        h('span', { key: 'label', className: 'dshwb-fieldLabel' }, label),
        children,
        hint ? h('span', { key: 'hint', className: 'dshwb-fieldHint' }, hint) : null,
      ]);
    }

    function Toast({ toast }) {
      if (!toast) return null;
      return h(
        'div',
        {
          className: `dshwb-toast dshwb-toast-${toast.kind || 'info'}`,
          role: 'status',
          'aria-live': 'polite',
        },
        h(Icon, { name: toast.kind === 'error' || toast.kind === 'hint' ? 'info' : 'check', size: 15 }),
        h('span', null, toast.message),
      );
    }

    function useToast() {
      const [toast, setToast] = React.useState(null);
      const timer = React.useRef();
      const show = React.useCallback((message, kind = 'info') => {
        if (!message) return;
        if (timer.current) clearTimeout(timer.current);
        setToast({ message, kind, key: Date.now() });
        timer.current = setTimeout(() => setToast(null), 3600);
      }, []);
      React.useEffect(() => { disabledToastListeners.add(show); return () => disabledToastListeners.delete(show); }, [show]);
      React.useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current);
        },
        [],
      );
      return [toast, show];
    }

    /** @returns the archive status of one recorded requirement. */
    function requirementStatus(item, copy) {
      const stage = STAGES.includes(item.stage) ? item.stage : STAGES[0];
      if (item.confirmed >= STAGES.length) return { key: 'done', label: copy.requirements.delivered, stage };
      if (item.started) return { key: 'active', label: copy.requirements.inProgress, stage };
      return { key: 'draft', label: copy.requirements.draft, stage };
    }

    /** One requirement row in the archive. */
    function RequirementRow({ item, copy, localeId, onOpen, onOpenSession, onRemove, selected, onSelect, removing }) {
      const status = requirementStatus(item, copy);
      const missing = item.exists === false;
      return h('li', { className: 'dshwb-reqRow' }, [
        h('input', { key: 'select', type: 'checkbox', className: 'dshwb-reqCheckbox', checked: selected, disabled: removing, title: '正在删除需求记录，请等待删除完成。',
          'aria-label': `${localeId === 'en' ? 'Select requirement' : '选择需求'}：${item.name || item.title || item.root}`,
          onChange: event => onSelect(event.target.checked) }),
        h('div', { key: 'main', className: 'dshwb-reqMain' }, [
          h('div', { key: 'titleRow', className: 'dshwb-reqTitleRow' }, [
            h('strong', { key: 'title', className: 'dshwb-reqTitle' }, item.name || item.title || item.root),
            h(
              'span',
              { key: 'status', className: `dshwb-reqStatus dshwb-reqStatus-${status.key}` },
              status.label,
            ),
            h(
              'span',
              { key: 'flow', className: 'dshwb-reqFlow' },
              copy.flow.roundBadge(item.round || 1, item.flow === 'incremental'),
            ),
            missing ? h('span', { key: 'gone', className: 'dshwb-reqGone' }, copy.requirements.gone) : null,
          ]),
          h(
            'p',
            { key: 'stage', className: 'dshwb-reqStage' },
            `${copy.requirements.stage} ${STAGES.indexOf(status.stage) + 1}/${STAGES.length} · ${copy.stage[status.stage].title} · ${copy.requirements.confirmed} ${item.confirmed}/${STAGES.length}`,
          ),
          item.goal ? h('p', { key: 'goal', className: 'dshwb-reqGoal' }, item.goal) : null,
          h('p', { key: 'meta', className: 'dshwb-reqMeta' }, [
            h('code', { key: 'root', className: 'dshwb-reqRoot', title: item.root }, item.root),
            h('span', { key: 'time' }, `${copy.requirements.updated} ${formatTime(item.updatedAt, localeId)}`),
          ]),
        ]),
        h('div', { key: 'actions', className: 'dshwb-reqActions' }, [
          h(
            Button,
            { key: 'open', kind: 'primary', size: 'xs', disabled: missing, disabledReason: '项目文件夹不存在或已移动，请重新选择有效的项目文件夹。', onClick: () => onOpen(item) },
            copy.requirements.open,
          ),
          h(
            Button,
            {
              key: 'session',
              kind: 'ghost',
              size: 'xs',
              disabled:
                (!item.sessionId &&
                  !item.specSessionId &&
                  !(item.stageSessions && Object.values(item.stageSessions).some((value) => value))) ||
                missing,
              disabledReason: missing ? '项目文件夹不存在或已移动，请重新选择项目文件夹。' : '这条需求还没有会话，请先开始对应阶段。',
              onClick: () => onOpenSession(item),
            },
            copy.requirements.openSession,
          ),
          h(
            Button,
            { key: 'remove', kind: 'ghost', size: 'xs', disabled: removing, disabledReason: '正在删除需求记录，请等待删除完成。', onClick: () => onRemove(item) },
            copy.requirements.remove,
          ),
        ]),
      ]);
    }

    /** The cross-project requirement archive. */
    function RequirementLibrary({ copy, localeId, archive, onOpen, onOpenSession, onRemove, onRemoveMany, removing, onBack, onRefresh }) {
      const items = archive.items || [];
      const en = localeId === 'en';
      const [selection, setSelection] = React.useState([]);
      const visibleKeys = new Set(items.map(requirementKey));
      const selected = new Set(selection.filter(key => visibleKeys.has(key)));
      const allSelected = items.length > 0 && items.every(item => selected.has(requirementKey(item)));
      React.useEffect(() => {
        setSelection(previous => {
          const next = previous.filter(key => visibleKeys.has(key));
          return next.length === previous.length ? previous : next;
        });
      }, [archive.items]);
      const selectOne = (item, checked) => setSelection(previous => {
        const next = new Set(previous); const key = requirementKey(item);
        if (checked) next.add(key); else next.delete(key);
        return [...next];
      });
      const removeSelected = async () => {
        if (await onRemoveMany(items.filter(item => selected.has(requirementKey(item))))) setSelection([]);
      };
      return h(
        Card,
        { className: 'dshwb-reqCard' },
        [
          h(SectionHead, {
            key: 'head',
            icon: 'doc',
            title: copy.requirements.title,
            desc: copy.requirements.sub,
            extra: h(
              Button,
              { kind: 'ghost', size: 'xs', onClick: onRefresh, title: copy.requirements.refresh },
              h(Icon, { name: 'refresh', size: 12 }),
            ),
          }),
          h('div', { key: 'bar', className: 'dshwb-reqBar' }, [
            h('span', { key: 'count', className: 'dshwb-reqCount' }, copy.requirements.count(items.length)),
            h(Button, { key: 'back', kind: 'ghost', size: 'xs', onClick: onBack }, copy.requirements.back),
          ]),
          h('div', { key: 'selection', className: 'dshwb-reqSelection', role: 'group', 'aria-label': en ? 'Bulk archive actions' : '需求批量操作' }, [
            h('label', { key: 'all' }, [
              h('input', { key: 'checkbox', type: 'checkbox', checked: allSelected, disabled: !items.length || removing || archive.phase !== 'ready',
                ref: element => { if (element) element.indeterminate = selected.size > 0 && !allSelected; },
                onChange: event => setSelection(event.target.checked ? items.map(requirementKey) : []) }),
              en ? 'Select all records' : '全选需求',
            ]),
            h('span', { key: 'count', role: 'status' }, en ? `${selected.size} selected` : `已选 ${selected.size} 项`),
            h(Button, { key: 'clear', size: 'xs', kind: 'ghost', disabled: !selected.size || removing, disabledReason: removing ? '正在删除记录，请等待完成。' : '请先勾选至少一条需求记录。', onClick: () => setSelection([]) }, en ? 'Clear selection' : '取消选择'),
            h(Button, { key: 'delete', size: 'xs', kind: 'secondary', disabled: !selected.size || removing || archive.phase !== 'ready', disabledReason: removing ? '正在删除记录，请等待完成。' : archive.phase !== 'ready' ? '需求列表尚未加载完成，请等待或刷新列表。' : '请先勾选至少一条需求记录。', onClick: removeSelected }, removing ? (en ? 'Removing…' : '正在删除…') : (en ? `Delete selected records (${selected.size})` : `删除选中记录（${selected.size}）`)),
            h('span', { key: 'hint', className: 'dshwb-hint' }, en ? 'Select all, then delete to remove this list. Project files stay untouched.' : '全选后可删除当前列表全部记录；项目代码、文档和会话均保留。'),
          ]),
          archive.phase === 'error'
            ? h(
                'div',
                { key: 'error', className: 'dshwb-docEmpty dshwb-docEmptyError' },
                h(Icon, { name: 'info', size: 18 }),
                copy.requirements.loadFailed,
              )
            : items.length === 0
              ? h(
                  'div',
                  { key: 'empty', className: 'dshwb-docEmpty' },
                  h(Icon, { name: 'doc', size: 22 }),
                  h('strong', null, copy.requirements.emptyTitle),
                  h('span', null, copy.requirements.empty),
                )
              : h(
                  'ul',
                  { key: 'list', className: 'dshwb-reqList' },
                  items.map((item) =>
                    h(RequirementRow, {
                      key: requirementKey(item),
                      item,
                      copy,
                      localeId,
                      onOpen,
                      onOpenSession,
                      onRemove,
                      removing,
                      selected: selected.has(requirementKey(item)),
                      onSelect: checked => selectOne(item, checked),
                    }),
                  ),
                ),
        ],
      );
    }

    function ProjectSetup({ state, meta, copy, store, onSave, onPickDirectory, onNewRound }) {
      const [open, setOpen] = React.useState(!str(state.project.name).trim());
      const [rootDraft, setRootDraft] = React.useState(meta.projectRoot);
      React.useEffect(() => {
        if (!str(state.project.name).trim()) setOpen(true);
      }, [state.project.name]);
      React.useEffect(() => {
        setRootDraft(meta.projectRoot);
      }, [meta.projectRoot]);
      if (!open) {
        return h(
          'div',
          { className: 'dshwb-projectBar' },
          h('span', { className: 'dshwb-projectBarName' }, projectLabel(state, meta, copy)),
          state.flow === 'incremental'
            ? h('span', { className: 'dshwb-roundBadge' }, copy.flow.roundBadge(state.round, true))
            : null,
          onNewRound
            ? h(Button, { kind: 'ghost', size: 'sm', onClick: onNewRound }, copy.flow.newRound)
            : null,
          h(
            Button,
            { kind: 'ghost', size: 'sm', onClick: () => setOpen(true) },
            copy.editProject,
          ),
        );
      }
      return h(
        'div',
        { className: 'dshwb-projectSetup' },
        h(
          'div',
          { key: 'head', className: 'dshwb-projectSetupHead' },
          h(Icon, { name: 'spark', size: 18 }),
          h('span', null, copy.project),
        ),
        h(
          'div',
          { key: 'root', className: 'dshwb-rootField' },
          h(
            Field,
            { label: copy.projectDir, hint: copy.projectDirHint },
            h(
              'div',
              { className: 'dshwb-inlineForm' },
              h('input', {
                className: 'dshwb-input',
                value: rootDraft,
                placeholder: '/absolute/path/to/project',
                spellCheck: false,
                onChange: (event) => setRootDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (rootDraft.trim() && rootDraft.trim() !== meta.projectRoot) store.setRoot(rootDraft.trim());
                  }
                },
              }),
              h(
                Button,
                {
                  kind: 'secondary',
                  size: 'sm',
                  disabled: !rootDraft.trim() || rootDraft.trim() === meta.projectRoot, disabledReason: !rootDraft.trim() ? '请先填写项目文件夹路径。' : '这个文件夹已是当前项目，请填写其他路径后再切换。',
                  onClick: () => store.setRoot(rootDraft.trim()),
                },
                copy.apply,
              ),
              onPickDirectory
                ? h(
                    Button,
                    {
                      kind: 'ghost',
                      size: 'sm',
                      onClick: async () => {
                        try {
                          const dir = await onPickDirectory();
                          if (dir) {
                            setRootDraft(dir);
                            await store.setRoot(dir);
                          }
                        } catch (error) {
                          /* The native picker was cancelled or unavailable. */
                        }
                      },
                    },
                    copy.chooseDir,
                  )
                : null,
            ),
          ),
        ),
        h(
          'div',
          { key: 'grid', className: 'dshwb-fieldGrid' },
          h(
            Field,
            { key: 'name', label: copy.projectName },
            h('input', {
              className: 'dshwb-input',
              value: state.project.name,
              placeholder: copy.projectNamePlaceholder,
              maxLength: 160,
              onChange: (event) => store.patchProject({ name: event.target.value }),
            }),
          ),
          h(
            Field,
            { key: 'goal', label: copy.projectGoal },
            h('textarea', {
              className: 'dshwb-input dshwb-textarea dshwb-goalInput',
              rows: 2,
              value: state.project.goal,
              placeholder: copy.projectGoalPlaceholder,
              maxLength: 4000,
              onChange: (event) => store.patchProject({ goal: event.target.value }),
            }),
          ),
        ),
        h(
          'div',
          { key: 'flow', className: 'dshwb-flowRow' },
          [
            h(
              'div',
              { key: 'segments', className: 'dshwb-segmented' },
              [
                h(
                  'button',
                  {
                    key: 'new',
                    type: 'button',
                    className: state.flow === 'incremental' ? 'dshwb-segment' : 'dshwb-segment dshwb-segmentActive',
                    onClick: () => store.setFlow('new'),
                  },
                  copy.flow.fresh,
                ),
                h(
                  'button',
                  {
                    key: 'incremental',
                    type: 'button',
                    className: state.flow === 'incremental' ? 'dshwb-segment dshwb-segmentActive' : 'dshwb-segment',
                    onClick: () => store.setFlow('incremental'),
                  },
                  copy.flow.incremental,
                ),
              ],
            ),
            h('p', { key: 'hint', className: 'dshwb-flowHint' }, copy.flow.hint),
          ],
        ),
        h(
          'div',
          { key: 'actions', className: 'dshwb-rowEnd' },
          h(
            Button,
            {
              kind: 'primary',
              size: 'sm',
              onClick: async () => {
                await store.setRoot(rootDraft.trim() || meta.projectRoot);
                const current = store.get();
                if (!current.project.createdAt) store.patchProject({ createdAt: new Date().toISOString() });
                setOpen(false);
                if (onSave) onSave();
              },
              disabled: !str(state.project.name).trim(), disabledReason: '请先填写项目名称，再创建需求。',
            },
            copy.saveProject,
          ),
        ),
      );
    }

    function StageRail({ state, copy, onSelect }) {
      const progress = STAGES.filter((stage) => state.stageData[stage].confirmed).length;
      return h('aside', { className: 'dshwb-rail' }, [
        h(
          'div',
          { key: 'progress', className: 'dshwb-railProgress' },
          h('div', { key: 'head', className: 'dshwb-railProgressHead' }, [
            h('span', { key: 'label' }, copy.progress),
            h('strong', { key: 'value' }, `${progress} / ${STAGES.length}`),
          ]),
          h(
            'div',
            { key: 'track', className: 'dshwb-progressTrack' },
            h('span', { style: { width: `${(progress / STAGES.length) * 100}%` } }),
          ),
        ),
        h(
          'nav',
          { key: 'nav', className: 'dshwb-stageNav', 'aria-label': copy.appTitle },
          STAGES.map((stage, index) => {
            const status = stageStatus(state, stage);
            const active = state.stage === stage;
            return h(
              'button',
              {
                key: stage,
                type: 'button',
                className: `dshwb-stageItem${active ? ' dshwb-stageItemActive' : ''} dshwb-stageItem-${status}`,
                'aria-current': active ? 'step' : undefined,
                onClick: () => onSelect(stage),
              },
              h(
                'span',
                { key: 'num', className: 'dshwb-stageNum' },
                status === 'confirmed' ? h(Icon, { name: 'check', size: 12 }) : String(index + 1),
              ),
              h('span', { key: 'body', className: 'dshwb-stageItemBody' }, [
                h('strong', { key: 'title' }, copy.stage[stage].short),
                h('span', { key: 'desc' }, `${copy.stage[stage].title} · ${copy.status[status] || copy.status.todo}`),
              ]),
              h('span', { key: 'dot', className: `dshwb-railDot dshwb-railDot-${status}` }),
            );
          }),
        ),
        h(
          'div',
          { key: 'guide', className: 'dshwb-railGuide' },
          h('p', { className: 'dshwb-railGuideTitle' }, copy.guideTitle),
          [1, 2, 3, 4].map((n) =>
            h(
              'p',
              { key: n, className: 'dshwb-railGuideStep' },
              h('span', null, String(n)),
              h('span', null, copy[`guide${n}`]),
            ),
          ),
        ),
      ]);
    }

    function ActivityRail({ state, copy }) {
      const items = state.activity.slice(-5).reverse();
      return h(
        'div',
        { className: 'dshwb-activity' },
        h('p', { className: 'dshwb-activityTitle' }, copy.activityTitle),
        items.length === 0
          ? h('p', { className: 'dshwb-muted' }, copy.activityEmpty)
          : h(
              'ul',
              { className: 'dshwb-activityList' },
              items.map((item) =>
                h(
                  'li',
                  { key: item.id, className: `dshwb-activityItem dshwb-activityItem-${item.kind}` },
                  h('span', { className: 'dshwb-activityDot', 'aria-hidden': true }),
                  h('div', null, [
                    h('span', { key: 'time', className: 'dshwb-activityTime' }, formatTime(item.time, 'zh')),
                    h('span', { key: 'text', className: 'dshwb-activityText' }, item.text),
                  ]),
                ),
              ),
            ),
      );
    }

    /* ------------------------------------------------------------------
     * Stage-specific bodies
     * ---------------------------------------------------------------- */

    function LockedNotice({ state, stage, copy, store }) {
      const index = STAGES.indexOf(stage);
      const previous = STAGES[index - 1];
      return h(
        Card,
        { className: 'dshwb-locked' },
        h(Icon, { name: 'lock', size: 22 }),
        h('h3', null, `${copy.stage[previous].title} ${copy.status.todo}`),
        h(
          'p',
          null,
          copy === TEXT.zh
            ? `完成并确认「${copy.stage[previous].title}」后，才能开始这一阶段。`
            : `Confirm “${copy.stage[previous].title}” before starting this stage.`,
        ),
        h(
          Button,
          { kind: 'secondary', size: 'sm', onClick: () => store.setStage(previous) },
          `${copy.stage[previous].short} →`,
        ),
      );
    }

    function SpecStage({ state, meta, copy, store, busy, onStart, onOpenSession, onConfirm, showToast }) {
      const spec = state.stageData.spec;
      const [checked, setChecked] = React.useState(false);
      const [uploading, setUploading] = React.useState(false);
      const [showPrompt, setShowPrompt] = React.useState(false);
      const fileRef = React.useRef(null);

      const upload = async (file) => {
        if (!file) return;
        setUploading(true);
        try {
          const buffer = await file.arrayBuffer();
          const response = await apiFetch(UPLOAD_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-workbench-filename': encodeURIComponent(file.name),
            },
            body: buffer,
          });
          const payload = await readApiJson(response).catch(() => ({}));
          if (!response.ok) throw new Error(payload.message || copy.spec.uploadFailed);
          store.patchStage('spec', {
            input: str(payload.text).slice(0, 100_000),
            sourceName: str(payload.name),
            sourcePath: str(payload.path),
          });
          store.addActivity(`${copy.spec.uploaded}: ${payload.name}`, 'info');
          showToast(`${copy.spec.uploaded}: ${payload.name}`, 'success');
        } catch (error) {
          showToast(String(error.message || copy.spec.uploadFailed), 'error');
        } finally {
          setUploading(false);
          if (fileRef.current) fileRef.current.value = '';
        }
      };

      return h(React.Fragment, null, [
        h(
          Card,
          { key: 'source' },
          h(SectionHead, {
            icon: 'doc',
            title: copy.spec.source,
            desc: copy.stage.spec.desc,
            extra: h(StatusPill, { status: stageStatus(state, 'spec'), copy }),
          }),
          h('textarea', {
            className: 'dshwb-input dshwb-bigTextarea',
            rows: 9,
            maxLength: 100_000,
            value: spec.input,
            placeholder: copy.spec.placeholder,
            onChange: (event) => store.patchStage('spec', { input: event.target.value }),
          }),
          h(
            'div',
            { className: 'dshwb-toolbar' },
            h(
              'div',
              { className: 'dshwb-toolbarLeft' },
              h('input', {
                ref: fileRef,
                type: 'file',
                accept: '.md,.markdown,.txt,.docx',
                style: { display: 'none' },
                onChange: (event) => upload(event.target.files?.[0]),
              }),
              h(
                Button,
                {
                  kind: 'ghost',
                  size: 'sm',
                  onClick: () => fileRef.current?.click(),
                  disabled: uploading, disabledReason: '正在上传文件，请等待上传完成。',
                },
                h(Icon, { name: 'upload', size: 14 }),
                uploading ? copy.spec.uploading : copy.action.upload,
              ),
              spec.sourceName
                ? h(
                    'span',
                    { className: 'dshwb-sourceTag' },
                    h(Icon, { name: 'doc', size: 12 }),
                    spec.sourceName,
                  )
                : null,
            ),
            h('span', { className: 'dshwb-counter' }, `${spec.input.length.toLocaleString()} / 100,000`),
          ),
          h('p', { className: 'dshwb-hint' }, copy.spec.uploadHint),
          h(
            'div',
            { className: 'dshwb-actionsRow' },
            h(
              Button,
              {
                kind: 'primary',
                onClick: () => onStart('spec'),
                disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。',
              },
              h(Icon, { name: 'spark', size: 15 }),
              spec.input.trim() ? copy.spec.analyze : copy.spec.interviewing,
            ),
            h(
              Button,
              {
                kind: 'secondary',
                onClick: onOpenSession,
                disabled: !state.sessionId, disabledReason: '请先开始当前阶段，创建会话后再打开。',
              },
              h(Icon, { name: 'chat', size: 14 }),
              copy.action.openSession,
            ),
            h(
              Button,
              { kind: 'ghost', size: 'sm', onClick: () => setShowPrompt((value) => !value) },
              showPrompt ? copy.action.dismiss : copy.spec.promptPreview,
            ),
          ),
          h('p', { className: 'dshwb-hint' }, copy.spec.clarify),
          showPrompt
            ? h('pre', { className: 'dshwb-promptPreview' }, buildStagePrompt(state, 'spec').slice(0, 6000))
            : null,
        ),
        h(
          Card,
          { key: 'confirm' },
          h(SectionHead, {
            icon: 'check',
            title: copy.spec.confirmTitle,
            desc: copy.spec.confirmHint,
          }),
          h(
            CheckRow,
            { checked, onChange: setChecked },
            copy.spec.confirmCheck,
          ),
          h(
            Field,
            { label: copy.spec.notes },
            h('textarea', {
              className: 'dshwb-input dshwb-textarea',
              rows: 2,
              value: spec.reviewNote,
              onChange: (event) => store.patchStage('spec', { reviewNote: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dshwb-actionsRow' },
            h(
              Button,
              {
                kind: 'primary',
                disabled: busy !== '' || !checked || spec.confirmed, disabledReason: busy !== '' ? '正在处理当前操作，请等待完成。' : spec.confirmed ? '当前版本已经确认；如需修改，请先重新开启该阶段。' : '请先勾选已审阅并确认当前阶段文档。',
                onClick: () => onConfirm('spec', spec.reviewNote),
              },
              spec.confirmed ? copy.status.confirmed : copy.action.confirm,
            ),
          ),
          h('p', { className: 'dshwb-hint' }, copy.spec.wordHint),
        ),
      ]);
    }

    function DesignStage({ state, copy, store, busy, onStart, onOpenSession, onConfirm }) {
      const design = state.stageData.design;
      const [checked, setChecked] = React.useState(false);
      const [newGate, setNewGate] = React.useState('');
      if (isLocked(state, 'design')) {
        return h(LockedNotice, { state, stage: 'design', copy, store });
      }

      const gates = Array.isArray(design.gates) ? design.gates : [];
      const gateLabel = (gate) => gateLabelOf(gate, copy);
      const toggleGate = (id, enabled) => {
        store.patchStage('design', {
          gates: gates.map((gate) => (gate.id === id ? { ...gate, enabled } : gate)),
        });
      };
      const addGate = () => {
        const text = newGate.trim();
        if (text === '') return;
        store.patchStage('design', {
          gates: [...gates, { id: uid('gate'), text: text.slice(0, 200), enabled: true }],
        });
        setNewGate('');
      };
      const removeGate = (id) => {
        store.patchStage('design', { gates: gates.filter((gate) => gate.id !== id) });
      };

      const plans = copy.design.plans || [];
      const custom = design.mode === 'custom';
      const selected = plans.find((plan) => plan.id === design.preset) || plans[0] || null;
      const stackRows = selected
        ? [
            [copy.design.frontend, selected.fields.frontend],
            [copy.design.backend, selected.fields.backend],
            [copy.design.database, selected.fields.database],
            [copy.design.deploy, selected.fields.deployTarget],
          ].filter(([, value]) => str(value) !== '')
        : [];

      const askAgent = !custom && Boolean(selected) && selected.id === 'agent';

      const choosePlan = (plan) => {
        store.patchStage('design', {
          mode: 'preset',
          preset: plan.id,
          ...(plan.id === 'agent' ? {} : plan.fields),
        });
      };

      const planSection = custom
        ? [
            h('p', { key: 'customSub', className: 'dshwb-hint' }, copy.design.customSub),
            h(
              'div',
              { key: 'fields', className: 'dshwb-fieldGrid' },
              [
                h(
                  Field,
                  { key: 'frontend', label: copy.design.frontend },
                  h('input', {
                    className: 'dshwb-input',
                    value: design.frontend,
                    placeholder: 'React / Vue / Next.js / 无前端',
                    onChange: (event) => store.patchStage('design', { frontend: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { key: 'backend', label: copy.design.backend },
                  h('input', {
                    className: 'dshwb-input',
                    value: design.backend,
                    placeholder: 'Node.js / Python / Go / 无后端',
                    onChange: (event) => store.patchStage('design', { backend: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { key: 'database', label: copy.design.database },
                  h('input', {
                    className: 'dshwb-input',
                    value: design.database,
                    placeholder: 'SQLite / PostgreSQL / MySQL / 无',
                    onChange: (event) => store.patchStage('design', { database: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { key: 'deploy', label: copy.design.deploy },
                  h('input', {
                    className: 'dshwb-input',
                    value: design.deployTarget,
                    placeholder: '本地 / Docker / 云服务器 / Vercel',
                    onChange: (event) => store.patchStage('design', { deployTarget: event.target.value }),
                  }),
                ),
              ],
            ),
          ]
        : [
            h(
              'div',
              { key: 'grid', className: 'dshwb-planGrid', role: 'radiogroup', 'aria-label': copy.design.planTitle },
              plans.map((plan) =>
                h(
                  'button',
                  {
                    key: plan.id,
                    type: 'button',
                    role: 'radio',
                    'aria-checked': plan.id === design.preset ? 'true' : 'false',
                    className: 'dshwb-planCard' + (plan.id === design.preset ? ' dshwb-planCardActive' : ''),
                    onClick: () => choosePlan(plan),
                  },
                  [
                    h(
                      'span',
                      { key: 'head', className: 'dshwb-planHead' },
                      [
                        h('strong', { key: 'name' }, plan.name),
                        plan.id === design.preset
                          ? h('span', { key: 'tag', className: 'dshwb-planTag' }, copy.design.selected)
                          : null,
                      ],
                    ),
                    h('span', { key: 'tagline', className: 'dshwb-planTagline' }, plan.tagline),
                    h(
                      'span',
                      { key: 'meta', className: 'dshwb-planMeta' },
                      [
                        h('span', { key: 'effort' }, `${copy.design.effort} · ${plan.effort}`),
                        h('span', { key: 'cost' }, `${copy.design.cost} · ${plan.cost}`),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            selected
              ? h('div', { key: 'detail', className: 'dshwb-planDetail' }, [
                  h(
                    'div',
                    { key: 'head', className: 'dshwb-planDetailHead' },
                    [
                      h('strong', { key: 'name' }, selected.name),
                      h('p', { key: 'tagline' }, selected.tagline),
                    ],
                  ),
                  stackRows.length
                    ? h('h5', { key: 'stackTitle', className: 'dshwb-planStackTitle' }, copy.design.stack)
                    : null,
                  stackRows.length
                    ? h(
                        'dl',
                        { key: 'stack', className: 'dshwb-planStack' },
                        stackRows.map(([label, value]) =>
                          h('div', { key: label, className: 'dshwb-planStackRow' }, [
                            h('dt', null, label),
                            h('dd', null, value),
                          ]),
                        ),
                      )
                    : null,
                  h('div', { key: 'compare', className: 'dshwb-planCompare' }, [
                    h('div', { key: 'pros', className: 'dshwb-planCol' }, [
                      h('h5', null, copy.design.pros),
                      h(
                        'ul',
                        null,
                        selected.pros.map((item) => h('li', { key: item }, item)),
                      ),
                    ]),
                    h('div', { key: 'cons', className: 'dshwb-planCol' }, [
                      h('h5', null, copy.design.cons),
                      h(
                        'ul',
                        null,
                        selected.cons.map((item) => h('li', { key: item }, item)),
                      ),
                    ]),
                  ]),
                  h('p', { key: 'fit', className: 'dshwb-planFit' }, `${copy.design.fit}：${selected.fit}`),
                ])
              : null,
          ];

      return h(React.Fragment, null, [
        h(
          Card,
          { key: 'prefs' },
          [
            h(SectionHead, {
              key: 'head',
              icon: 'command',
              title: custom ? copy.design.customTitle : copy.design.title,
              desc: copy.design.sub,
              extra: h(StatusPill, { status: stageStatus(state, 'design'), copy }),
            }),
            h(
              'div',
              { key: 'switch', className: 'dshwb-planSwitch' },
              [
                h('span', { key: 'hint', className: 'dshwb-planSwitchHint' }, copy.design.planHint),
                h(
                  Button,
                  {
                    key: 'toggle',
                    kind: 'ghost',
                    size: 'xs',
                    onClick: () => store.patchStage('design', { mode: custom ? 'preset' : 'custom' }),
                  },
                  custom ? copy.design.backToPlans : copy.design.customToggle,
                ),
              ],
            ),
            h('div', { key: 'section', className: 'dshwb-planSection' }, planSection),
            h(
              Field,
              { key: 'constraints', label: copy.design.constraints, hint: copy.design.constraintsHint },
              h('textarea', {
                className: 'dshwb-input dshwb-textarea',
                rows: 3,
                value: design.constraints,
                placeholder: copy.design.constraintsPlaceholder,
                onChange: (event) => store.patchStage('design', { constraints: event.target.value }),
              }),
            ),
            h(
              'div',
              { key: 'actions', className: 'dshwb-actionsRow' },
              [
                h(
                  Button,
                  { key: 'generate', kind: 'primary', onClick: () => onStart('design'), disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。' },
                  h(Icon, { name: 'spark', size: 15 }),
                  askAgent ? copy.design.generateOptions : copy.design.generate,
                ),
                h(
                  Button,
                  { key: 'chat', kind: 'secondary', onClick: onOpenSession, disabled: !state.sessionId, disabledReason: '请先开始当前阶段，创建会话后再打开。' },
                  h(Icon, { name: 'chat', size: 14 }),
                  copy.action.openSession,
                ),
              ],
            ),
            h('p', { key: 'hint', className: 'dshwb-hint' }, copy.design.interviewHint),
          ],
        ),
        h(
          Card,
          { key: 'gates' },
          [
            h(SectionHead, {
              key: 'head',
              icon: 'lock',
              title: copy.design.gatesTitle,
              desc: copy.design.gatesHint,
            }),
            h(
              'ul',
              { key: 'list', className: 'dshwb-checkList' },
              gates.map((gate) =>
                h(
                  'li',
                  { key: gate.id, className: 'dshwb-checkItem' },
                  [
                    h(
                      CheckRow,
                      {
                        key: 'check',
                        checked: gate.enabled,
                        onChange: (enabled) => toggleGate(gate.id, enabled),
                      },
                      gateLabel(gate),
                    ),
                    h(
                      'button',
                      {
                        key: 'remove',
                        type: 'button',
                        className: 'dshwb-iconBtn',
                        title: copy.action.remove,
                        onClick: () => removeGate(gate.id),
                      },
                      h(Icon, { name: 'trash', size: 13 }),
                    ),
                  ],
                ),
              ),
            ),
            h('div', { key: 'add', className: 'dshwb-inlineForm' }, [
              h('input', {
                key: 'input',
                className: 'dshwb-input',
                value: newGate,
                maxLength: 200,
                placeholder: copy.design.gateAdd,
                onChange: (event) => setNewGate(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addGate();
                  }
                },
              }),
              h(
                Button,
                { key: 'btn', kind: 'secondary', size: 'sm', onClick: addGate, disabled: !newGate.trim(), disabledReason: '请先填写需要添加的设计检查项。' },
                copy.action.add,
              ),
            ]),
            h('p', { key: 'note', className: 'dshwb-hint' }, copy.design.gatesNote),
          ],
        ),
        h(
          Card,
          { key: 'confirm' },
          h(SectionHead, {
            icon: 'check',
            title: copy.design.confirmTitle,
            desc: copy.design.confirmHint,
          }),
          h(CheckRow, { checked, onChange: setChecked }, copy.design.confirmCheck),
          h(
            Field,
            { label: copy.spec.notes },
            h('textarea', {
              className: 'dshwb-input dshwb-textarea',
              rows: 2,
              value: design.reviewNote,
              onChange: (event) => store.patchStage('design', { reviewNote: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dshwb-actionsRow' },
            h(
              Button,
              {
                kind: 'primary',
                disabled: busy !== '' || !checked || design.confirmed, disabledReason: busy !== '' ? '正在处理当前操作，请等待完成。' : design.confirmed ? '当前版本已经确认；如需修改，请先重新开启该阶段。' : '请先勾选已审阅并确认当前阶段文档。',
                onClick: () => onConfirm('design', design.reviewNote),
              },
              design.confirmed ? copy.status.confirmed : copy.action.confirm,
            ),
          ),
        ),
      ]);
    }

    function BuildStage({ state, copy, store, busy, onStart, onOpenSession, onConfirm, onOpenPreview }) {
      const build = state.stageData.build;
      const [checked, setChecked] = React.useState(false);
      const [newItem, setNewItem] = React.useState('');
      if (isLocked(state, 'build')) {
        return h(LockedNotice, { state, stage: 'build', copy, store });
      }
      const items = build.confirmations;
      const gates = (Array.isArray(state.stageData.design.gates) ? state.stageData.design.gates : []).filter(
        (gate) => gate.enabled,
      );
      const allDone = items.length > 0 && items.every((item) => item.done);
      const labelFor = (item) =>
        item.id === 'default-1'
          ? copy.build.default1
          : item.id === 'default-2'
            ? copy.build.default2
            : item.id === 'default-3'
              ? copy.build.default3
              : item.text;

      const toggleItem = (id, done) => {
        store.setBuildChecks(items.map((item) => (item.id === id ? { ...item, done } : item)));
      };
      const addItem = () => {
        const text = newItem.trim();
        if (!text) return;
        store.setBuildChecks([...items, { id: uid('check'), text, done: false }]);
        setNewItem('');
      };
      const removeItem = (id) => store.setBuildChecks(items.filter((item) => item.id !== id));

      return h(React.Fragment, null, [
        h(
          Card,
          { key: 'start' },
          h(SectionHead, {
            icon: 'play',
            title: copy.stage.build.title,
            desc: copy.stage.build.desc,
            extra: h(StatusPill, { status: stageStatus(state, 'build'), copy }),
          }),
          h('p', { className: 'dshwb-bodyText' }, copy.build.hint),
          h(
            'div',
            { className: 'dshwb-actionsRow' },
            h(
              Button,
              { kind: 'primary', onClick: () => onStart('build'), disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。' },
              h(Icon, { name: 'play', size: 14 }),
              copy.build.start,
            ),
            h(
              Button,
              { kind: 'secondary', onClick: onOpenSession, disabled: !state.sessionId, disabledReason: '请先开始当前阶段，创建会话后再打开。' },
              h(Icon, { name: 'chat', size: 14 }),
              copy.action.openSession,
            ),
            h(
              Button,
              { kind: 'ghost', onClick: onOpenPreview },
              h(Icon, { name: 'monitor', size: 14 }),
              copy.build.preview,
            ),
          ),
        ),
        h(
          Card,
          { key: 'checks' },
          h(SectionHead, {
            icon: 'check',
            title: copy.build.checksTitle,
            desc: copy.build.checksHint,
          }),
          h('div', { key: 'gates', className: 'dshwb-gateBlock' }, [
            h('div', { key: 'head', className: 'dshwb-gateHead' }, [
              h('strong', { key: 'title' }, copy.build.gatesTitle),
              h('span', { key: 'hint', className: 'dshwb-gateHint' }, copy.build.gatesHint),
            ]),
            gates.length === 0
              ? h('p', { key: 'empty', className: 'dshwb-hint' }, copy.build.gatesNone)
              : h(
                  'ul',
                  { key: 'list', className: 'dshwb-gateList' },
                  gates.map((gate) =>
                    h(
                      'li',
                      { key: gate.id, className: 'dshwb-gateItem' },
                      [
                        h('span', { key: 'dot', className: 'dshwb-gateDot', 'aria-hidden': true }),
                        h('span', { key: 'text' }, gateLabelOf(gate, copy)),
                      ],
                    ),
                  ),
                ),
            h(
              Button,
              { key: 'adjust', kind: 'ghost', size: 'xs', onClick: () => store.setStage('design') },
              copy.build.gatesAdjust,
            ),
          ]),
          h(
            'ul',
            { className: 'dshwb-checkList' },
            items.map((item) =>
              h(
                'li',
                { key: item.id, className: 'dshwb-checkItem' },
                h(
                  CheckRow,
                  { checked: item.done, onChange: (done) => toggleItem(item.id, done) },
                  labelFor(item),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshwb-iconBtn',
                    title: copy.action.remove,
                    onClick: () => removeItem(item.id),
                  },
                  h(Icon, { name: 'trash', size: 13 }),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshwb-inlineForm' },
            h('input', {
              className: 'dshwb-input',
              value: newItem,
              maxLength: 300,
              placeholder: copy.build.itemPlaceholder,
              onChange: (event) => setNewItem(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addItem();
                }
              },
            }),
            h(Button, { kind: 'secondary', size: 'sm', onClick: addItem, disabled: !newItem.trim(), disabledReason: '请先填写需要添加的实现检查项。' }, copy.action.add),
          ),
          h(
            'div',
            { className: 'dshwb-confirmBlock' },
            h(CheckRow, { checked, onChange: setChecked }, copy.build.confirmCheck),
            h(
              Button,
              {
                kind: 'primary',
                disabled: busy !== '' || !checked || !allDone || build.confirmed, disabledReason: busy !== '' ? '正在处理当前操作，请等待完成。' : build.confirmed ? '当前版本已经确认；如需修改，请先重新开启该阶段。' : !allDone ? '请先完成全部实现检查项。' : '请先勾选已审阅并确认实现文档。',
                onClick: () => onConfirm('build', build.reviewNote),
              },
              build.confirmed ? copy.status.confirmed : copy.action.confirm,
            ),
          ),
          h('p', { className: 'dshwb-hint' }, copy.build.confirmHint),
        ),
      ]);
    }

    function VerifyStage({ state, copy, store, busy, onStart, onFix, onOpenSession, onConfirm }) {
      const verify = state.stageData.verify;
      const [checked, setChecked] = React.useState(false);
      if (isLocked(state, 'verify')) {
        return h(LockedNotice, { state, stage: 'verify', copy, store });
      }
      return h(React.Fragment, null, [
        h(
          Card,
          { key: 'run' },
          h(SectionHead, {
            icon: 'play',
            title: copy.stage.verify.title,
            desc: copy.stage.verify.desc,
            extra: h(StatusPill, { status: stageStatus(state, 'verify'), copy }),
          }),
          h('p', { className: 'dshwb-bodyText' }, copy.verify.hint),
          h(
            'div',
            { className: 'dshwb-actionsRow' },
            h(
              Button,
              { kind: 'primary', onClick: () => onStart('verify'), disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。' },
              h(Icon, { name: 'play', size: 14 }),
              copy.verify.run,
            ),
            h(
              Button,
              { kind: 'secondary', onClick: onOpenSession, disabled: !state.sessionId, disabledReason: '请先开始当前阶段，创建会话后再打开。' },
              h(Icon, { name: 'chat', size: 14 }),
              copy.action.openSession,
            ),
          ),
        ),
        h(
          Card,
          { key: 'fix' },
          h(SectionHead, {
            icon: 'info',
            title: copy.verify.fixTitle,
            desc: copy.verify.fixHint,
          }),
          h(
            'div',
            { className: 'dshwb-actionsRow' },
            h(
              Button,
              { kind: 'secondary', onClick: onFix, disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。' },
              h(Icon, { name: 'refresh', size: 14 }),
              copy.verify.fix,
            ),
            verify.fixRounds > 0
              ? h('span', { className: 'dshwb-muted' }, `${copy.verify.fix} × ${verify.fixRounds}`)
              : null,
          ),
        ),
        h(
          Card,
          { key: 'confirm' },
          h(SectionHead, {
            icon: 'check',
            title: copy.verify.confirmTitle,
            desc: copy.verify.confirmHint,
          }),
          h(CheckRow, { checked, onChange: setChecked }, copy.verify.confirmCheck),
          h(
            Field,
            { label: copy.spec.notes },
            h('textarea', {
              className: 'dshwb-input dshwb-textarea',
              rows: 2,
              value: verify.reviewNote,
              onChange: (event) => store.patchStage('verify', { reviewNote: event.target.value }),
            }),
          ),
          h(
            Button,
            {
              kind: 'primary',
              disabled: busy !== '' || !checked || verify.confirmed, disabledReason: busy !== '' ? '正在处理当前操作，请等待完成。' : verify.confirmed ? '当前版本已经确认；如需修改，请先重新开启该阶段。' : '请先勾选已审阅并确认当前阶段文档。',
              onClick: () => onConfirm('verify', verify.reviewNote),
            },
            verify.confirmed ? copy.status.confirmed : copy.action.confirm,
          ),
        ),
      ]);
    }

    function ShipStage({ state, copy, store, busy, onStart, onDeploy, onOpenSession, onConfirm, showToast }) {
      const ship = state.stageData.ship;
      const [checked, setChecked] = React.useState(false);
      const [authorized, setAuthorized] = React.useState(false);
      const [deploying, setDeploying] = React.useState(false);
      if (isLocked(state, 'ship')) {
        return h(LockedNotice, { state, stage: 'ship', copy, store });
      }

      const fieldsReady =
        ship.mode === 'ssh' &&
        ship.host.trim() !== '' &&
        ship.user.trim() !== '' &&
        ship.path.trim() !== '';
      const deploy = async () => {
        if (!fieldsReady || !authorized) {
          showToast(copy.toast.deployNeeds, 'error');
          return;
        }
        setDeploying(true);
        try {
          await onDeploy();
        } finally {
          setDeploying(false);
        }
      };

      return h(React.Fragment, null, [
        h(
          Card,
          { key: 'release' },
          h(SectionHead, {
            icon: 'doc',
            title: copy.stage.ship.title,
            desc: copy.stage.ship.desc,
            extra: h(StatusPill, { status: stageStatus(state, 'ship'), copy }),
          }),
          h('p', { className: 'dshwb-bodyText' }, copy.ship.hint),
          h(
            'div',
            { className: 'dshwb-actionsRow' },
            h(
              Button,
              { kind: 'primary', onClick: () => onStart('ship'), disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。' },
              h(Icon, { name: 'doc', size: 14 }),
              ship.mode === 'ssh' ? copy.ship.generate : copy.ship.generateNone,
            ),
            h(
              Button,
              { kind: 'secondary', onClick: onOpenSession, disabled: !state.sessionId, disabledReason: '请先开始当前阶段，创建会话后再打开。' },
              h(Icon, { name: 'chat', size: 14 }),
              copy.action.openSession,
            ),
          ),
        ),
        h(
          Card,
          { key: 'deploy' },
          h(SectionHead, {
            icon: 'server',
            title: copy.stage.ship.title,
            desc: copy.ship.deployWarn,
          }),
          h(
            'div',
            { className: 'dshwb-segmented' },
            h(
              'button',
              {
                type: 'button',
                className: ship.mode === 'none' ? 'dshwb-segment dshwb-segmentActive' : 'dshwb-segment',
                onClick: () => store.patchStage('ship', { mode: 'none' }),
              },
              copy.ship.modeNone,
            ),
            h(
              'button',
              {
                type: 'button',
                className: ship.mode === 'ssh' ? 'dshwb-segment dshwb-segmentActive' : 'dshwb-segment',
                onClick: () => store.patchStage('ship', { mode: 'ssh' }),
              },
              copy.ship.modeSSH,
            ),
          ),
          ship.mode === 'ssh'
            ? h(
                'div',
                { className: 'dshwb-fieldGrid dshwb-deployGrid' },
                h(
                  Field,
                  { key: 'host', label: copy.ship.host },
                  h('input', {
                    className: 'dshwb-input',
                    value: ship.host,
                    placeholder: 'example.com / 203.0.113.10',
                    onChange: (event) => store.patchStage('ship', { host: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { key: 'port', label: copy.ship.port },
                  h('input', {
                    className: 'dshwb-input',
                    value: ship.port,
                    placeholder: '22',
                    onChange: (event) => store.patchStage('ship', { port: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { key: 'user', label: copy.ship.user },
                  h('input', {
                    className: 'dshwb-input',
                    value: ship.user,
                    placeholder: 'deploy',
                    onChange: (event) => store.patchStage('ship', { user: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { key: 'path', label: copy.ship.path },
                  h('input', {
                    className: 'dshwb-input',
                    value: ship.path,
                    placeholder: '/srv/app',
                    onChange: (event) => store.patchStage('ship', { path: event.target.value }),
                  }),
                ),
                h(
                  Field,
                  { key: 'method', label: copy.ship.method },
                  h(
                    'select',
                    {
                      className: 'dshwb-input',
                      value: ship.method,
                      onChange: (event) => store.patchStage('ship', { method: event.target.value }),
                    },
                    ['rsync', 'git', 'docker', 'manual'].map((method) =>
                      h('option', { key: method, value: method }, method),
                    ),
                  ),
                ),
              )
            : null,
          ship.mode === 'ssh'
            ? h(
                'div',
                { className: 'dshwb-deployAuth' },
                h(CheckRow, { checked: authorized, onChange: setAuthorized }, copy.ship.auth),
                h(
                  Button,
                  {
                    kind: 'primary',
                    disabled: busy !== '' || deploying || !fieldsReady || !authorized, disabledReason: busy !== '' || deploying ? '正在执行操作，请等待完成。' : !fieldsReady ? '请先填写完整的服务器部署信息。' : '请先勾选部署授权，再开始部署。',
                    onClick: deploy,
                  },
                  h(Icon, { name: 'server', size: 14 }),
                  deploying ? copy.status.running : copy.ship.deploy,
                ),
              )
            : h('p', { className: 'dshwb-hint' }, copy.ship.noDeployNote),
        ),
        h(
          Card,
          { key: 'confirm' },
          h(SectionHead, {
            icon: 'check',
            title: copy.ship.confirmTitle,
            desc: copy.ship.confirmHint,
          }),
          h(CheckRow, { checked, onChange: setChecked }, copy.ship.confirmCheck),
          h('p', { key: 'needs', className: 'dshwb-hint' }, copy.ship.confirmNeeds),
          h(
            Field,
            { label: copy.spec.notes },
            h('textarea', {
              className: 'dshwb-input dshwb-textarea',
              rows: 2,
              value: ship.reviewNote,
              onChange: (event) => store.patchStage('ship', { reviewNote: event.target.value }),
            }),
          ),
          h(
            Button,
            {
              kind: 'primary',
              disabled: busy !== '' || !checked || ship.confirmed, disabledReason: busy !== '' ? '正在处理当前操作，请等待完成。' : ship.confirmed ? '当前版本已经确认；如需修改，请先重新开启该阶段。' : '请先勾选已审阅并确认当前阶段文档。',
              onClick: () => onConfirm('ship', ship.reviewNote),
            },
            ship.confirmed ? copy.status.confirmed : copy.action.confirm,
          ),
        ),
      ]);
    }

    /* ------------------------------------------------------------------
     * Document and project preview panes
     * ---------------------------------------------------------------- */

    function DocumentPane({ state, copy, stage, docsVersion, onGenerateDocx, onRefresh, showToast, onRequestChanges, localeId, initialPath, managerMode }) {
      const expected = stageDocs(state, stage);
      const library = useDocumentLibrary(docsVersion);
      const [selected, setSelected] = React.useState(initialPath || '');
      const [copied, setCopied] = React.useState(false);
      const [saving, setSaving] = React.useState('');
      const available = new Map(library.files.map((file) => [file.path, file]));

      // Expected deliverables first, then any other document the agent wrote.
      const entries = [];
      for (const item of expected) {
        entries.push({ ...item, extra: false, file: available.get(item.path) || null });
      }
      for (const file of library.files) {
        if (expected.some((item) => item.path === file.path)) continue;
        entries.push({ path: file.path, label: file.path, role: 'extra', extra: true, file });
      }
      const entriesKey = entries.map((entry) => `${entry.path}#${entry.file ? '1' : '0'}`).join('|');

      React.useEffect(() => {
        setSelected((current) =>
          current && entries.some((entry) => entry.path === current)
            ? current
            : (entries.find((entry) => entry.file) || entries[0] || { path: '' }).path,
        );
        // Only list membership decides what is selected.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [entriesKey]);

      const current = entries.find((item) => item.path === selected) || entries[0] || null;
      const exists = Boolean(current && current.file);
      const kind = current && current.file ? current.file.kind : kindOfPath(current ? current.path : '');
      const reviewable = current && !current.extra && /\.(md|txt|markdown)$/i.test(current.path);
      const doc = useDocument(current ? current.path : '', docsVersion, exists && isTextKind(kind) && !reviewable);

      const copyPath = async () => {
        if (!current) return;
        const path = current.file?.physicalPath || (current.extra ? current.path : `${state.artifactStorage?.directory || ""}/documents/${current.path}`);
        const ok = await copyText(path);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      };

      const download = async () => {
        if (!current || !exists) return;
        setSaving(current.path);
        try {
          await saveDocument(current.path);
        } catch (error) {
          showToast?.(String(error.message || error), 'error');
        } finally {
          setSaving('');
        }
      };

      const stats = current && current.file
        ? [
            h('span', { key: 'updated' }, `${copy.docs.updated} ${formatTime(current.file.mtime, 'zh')}`),
            h('span', { key: 'size' }, `${copy.docs.size} ${formatBytes(current.file.size)}`),
            kind === 'docx' ? h('span', { key: 'word', className: 'dshwb-docBadge' }, copy.docs.wordPreview) : null,
            kind === 'pdf' ? h('span', { key: 'pdf', className: 'dshwb-docBadge' }, copy.docs.pdfBadge) : null,
          ]
        : null;

      const body = !current
        ? h(
            'div',
            { key: 'empty', className: 'dshwb-docEmpty' },
            h(Icon, { name: 'doc', size: 22 }),
            h('strong', null, copy.docs.emptyTitle),
            h('span', null, copy.docs.emptyHint),
          )
        : !exists
          ? h(
              'div',
              { key: 'missing', className: 'dshwb-docEmpty' },
              h(Icon, { name: 'doc', size: 22 }),
              h('strong', null, copy.docs.missing),
              h('span', null, copy.docs.emptyHint),
              h('code', null, current.path),
            )
          : reviewable
            ? h(ReviewDocument, { key: `${state.boardId}:${current.path}`, name: current.path, state,
                refreshVersion: docsVersion, onRequestChanges, showToast, localeId, managerMode })
          : kind === 'pdf'
            ? h(
                'div',
                { key: 'pdf', className: 'dshwb-docBody' },
                h('div', { key: 'stats', className: 'dshwb-docStats' }, stats),
                h(PdfPreview, { key: current.path, path: current.path, copy }),
                h('p', { key: 'hint', className: 'dshwb-hint' }, copy.docs.stageHint),
              )
            : doc.data && doc.data.unsupported
              ? h(
                  'div',
                  { key: 'unsupported', className: 'dshwb-docEmpty' },
                  h(Icon, { name: 'info', size: 18 }),
                  copy.docs.unsupported,
                  h('code', null, current.path),
                )
              : doc.data
                ? h(
                    'div',
                    { key: 'body', className: 'dshwb-docBody' },
                    h('div', { key: 'stats', className: 'dshwb-docStats' }, stats),
                    h(MarkdownView, { text: doc.data.text, kind: doc.data.kind }),
                    h('p', { key: 'hint', className: 'dshwb-hint' }, copy.docs.stageHint),
                  )
                : doc.phase === 'error'
                  ? h(
                      'div',
                      { key: 'error', className: 'dshwb-docEmpty dshwb-docEmptyError' },
                      h(Icon, { name: 'info', size: 18 }),
                      copy.docs.loadError,
                      h('code', null, doc.error),
                    )
                  : h(
                      'div',
                      { key: 'loading', className: 'dshwb-docEmpty' },
                      h('span', { className: 'dshwb-spinner', 'aria-hidden': true }),
                      copy.docs.emptyHint,
                    );

      return h('div', { className: 'dshwb-docPane' }, [
        h(
          'div',
          { key: 'tabs', className: 'dshwb-docTabs', role: 'group', 'aria-label': copy.docs.tab },
          entries.map((item) =>
            h(
              'button',
              {
                key: item.path,
                type: 'button',
                'aria-pressed': item.path === selected,
                'data-exists': item.file ? 'true' : 'false',
                className:
                  'dshwb-docTab' +
                  (item.path === selected ? ' dshwb-docTabActive' : '') +
                  (item.file ? '' : ' dshwb-docTabMissing') +
                  (item.extra ? ' dshwb-docTabExtra' : ''),
                title: item.extra ? (item.file?.scope === 'board' ? (localeId === 'en' ? 'Other documents in this round' : '本轮其他阶段文档') : copy.docs.extra) : item.path,
                onClick: () => setSelected(item.path),
              },
              h(Icon, { name: 'doc', size: 13 }),
              item.label,
            ),
          ),
        ),
        h(
          'div',
          { key: 'meta', className: 'dshwb-docMeta' },
          h('code', { key: 'path', className: 'dshwb-docPath' }, current ? current.path : copy.docs.emptyTitle),
          h(
            'div',
            { key: 'actions', className: 'dshwb-docActions' },
            current?.role === 'word' && stage === 'spec'
              ? h(
                  Button,
                  { kind: 'ghost', size: 'xs', onClick: onGenerateDocx },
                  copy.docs.generateWord,
                )
              : null,
            h(
              Button,
              {
                kind: 'ghost',
                size: 'xs',
                onClick: download,
                disabled: !exists || saving !== '', disabledReason: saving !== '' ? '正在生成文档，请等待完成。' : '请先生成对应的原始文档，再导出 Word。',
                title: copy.docs.download,
              },
              h(Icon, { name: 'download', size: 12 }),
              saving === current?.path ? copy.docs.downloading : copy.docs.downloadShort,
            ),
            h(
              Button,
              { kind: 'ghost', size: 'xs', onClick: onRefresh, title: copy.action.refresh },
              h(Icon, { name: 'refresh', size: 12 }),
            ),
            h(
              Button,
              { kind: 'ghost', size: 'xs', onClick: copyPath, title: copy.docs.copyPath, disabled: !current, disabledReason: '请先选择一份文档，再复制路径。' },
              h(Icon, { name: copied ? 'check' : 'copy', size: 12 }),
              copied ? copy.action.copied : copy.action.copy,
            ),
          ),
        ),
        library.phase === 'error' && entries.length === 0
          ? h(
              'div',
              { key: 'libraryError', className: 'dshwb-docEmpty dshwb-docEmptyError' },
              h(Icon, { name: 'info', size: 18 }),
              copy.docs.libraryFailed,
            )
          : body,
      ]);
    }

    function ProjectPreviewPane({ state, copy, store, showToast }) {
      const [url, setUrl] = React.useState(state.previewUrl);
      const [frameKey, setFrameKey] = React.useState(0);
      const [device, setDevice] = React.useState('desktop');
      const [probing, setProbing] = React.useState(false);
      const [status, setStatus] = React.useState('');
      React.useEffect(() => {
        setUrl(state.previewUrl);
      }, [state.previewUrl]);

      const save = () => {
        store.setPreviewUrl(url.trim());
        setFrameKey((key) => key + 1);
      };
      const probe = async () => {
        setProbing(true);
        setStatus(copy.preview.probing);
        try {
          const response = await apiFetch(PROBE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(url.trim() ? { url: url.trim() } : {}),
          });
          const payload = await readApiJson(response);
          if (payload.ok) {
            setUrl(payload.url);
            store.setPreviewUrl(payload.url);
            setFrameKey((key) => key + 1);
            setStatus(copy.preview.found + (payload.title ? ` ${payload.title}` : ''));
          } else {
            setStatus(copy.preview.notFound);
          }
        } catch (error) {
          setStatus(copy.preview.notFound);
        } finally {
          setProbing(false);
        }
      };
      const width = device === 'mobile' ? 390 : device === 'tablet' ? 768 : 0;
      return h('div', { className: 'dshwb-previewPane' }, [
        h(
          'div',
          { key: 'form', className: 'dshwb-previewForm' },
          h(
            'div',
            { key: 'row', className: 'dshwb-previewUrlRow' },
            h('input', {
              className: 'dshwb-input',
              value: url,
              placeholder: copy.preview.urlPlaceholder,
              onChange: (event) => setUrl(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') save();
              },
            }),
            h(Button, { kind: 'secondary', size: 'sm', onClick: save }, copy.action.save),
          ),
          h(
            'div',
            { key: 'tools', className: 'dshwb-previewTools' },
            h(
              Button,
              { kind: 'ghost', size: 'xs', onClick: probe, disabled: probing, disabledReason: '正在检查预览地址，请等待检查完成。' },
              probing ? copy.preview.probing : copy.action.probe,
            ),
            h(
              Button,
              { kind: 'ghost', size: 'xs', onClick: () => setFrameKey((key) => key + 1) },
              h(Icon, { name: 'refresh', size: 12 }),
              copy.preview.refresh,
            ),
            url
              ? h(
                  'a',
                  {
                    className: 'dshwb-linkBtn',
                    href: url,
                    target: '_blank',
                    rel: 'noreferrer',
                  },
                  h(Icon, { name: 'external', size: 12 }),
                  copy.action.open,
                )
              : null,
            h(
              'div',
              { key: 'device', className: 'dshwb-deviceSwitch' },
              ['desktop', 'tablet', 'mobile'].map((key) =>
                h(
                  'button',
                  {
                    key,
                    type: 'button',
                    className: device === key ? 'dshwb-deviceBtn dshwb-deviceBtnActive' : 'dshwb-deviceBtn',
                    onClick: () => setDevice(key),
                    title: copy.preview[key],
                  },
                  key === 'desktop' ? '▭' : key === 'tablet' ? '▯' : '▯',
                ),
              ),
            ),
          ),
          status ? h('p', { key: 'status', className: 'dshwb-previewStatus' }, status) : null,
        ),
        url
          ? h(
              'div',
              {
                key: 'frame',
                className: `dshwb-frameWrap dshwb-frame-${device}`,
              },
              h('iframe', {
                key: frameKey,
                className: 'dshwb-frame',
                src: url,
                title: copy.preview.title,
                style: width ? { width: `${width}px` } : undefined,
                sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups',
              }),
            )
          : h(
              'div',
              { key: 'empty', className: 'dshwb-docEmpty dshwb-previewEmpty' },
              h(Icon, { name: 'monitor', size: 26 }),
              h('strong', null, copy.preview.noUrl),
              h('span', null, copy.preview.hint),
              h(
                'div',
                { className: 'dshwb-quickPorts' },
                ['5173', '3000', '8080'].map((port) =>
                  h(
                    'button',
                    {
                      key: port,
                      type: 'button',
                      className: 'dshwb-chip',
                      onClick: () => {
                        const next = `http://localhost:${port}`;
                        setUrl(next);
                        store.setPreviewUrl(next);
                        setFrameKey((key) => key + 1);
                      },
                    },
                    `localhost:${port}`,
                  ),
                ),
              ),
            ),
        h('p', { key: 'hint', className: 'dshwb-previewHint' }, copy.preview.hint),
      ]);
    }

    /* ------------------------------------------------------------------
     * Embedded conversation
     *
     * The dock hosts the real Conversation content instead of sending the
     * person to another panel: one retained Session reference feeds the
     * shared `conversation.content` Factory, so the composer, question cards
     * and tool approvals all work in place.
     * ---------------------------------------------------------------- */

    /**
     * Hold one Client Session reference while the workbench shows that Session.
     * @param sessionId - workbench Session, empty before the first stage action.
     * @param retain - `ctx.sessions.retain` bound by the registration.
     * @returns the owned reference plus whether the Session could not be acquired.
     */
    function useSessionReference(sessionId, retain) {
      const [held, setHeld] = React.useState({ reference: null, failed: false });
      React.useEffect(() => {
        if (!sessionId) {
          setHeld({ reference: null, failed: false });
          return undefined;
        }
        if (typeof retain !== 'function') {
          setHeld({ reference: null, failed: true });
          return undefined;
        }
        let owned;
        try {
          owned = retain(sessionId);
        } catch (error) {
          console.warn('workbench: cannot retain the workbench conversation:', error);
          setHeld({ reference: null, failed: true });
          return undefined;
        }
        setHeld({ reference: owned, failed: false });
        return () => {
          setHeld((current) => (current.reference === owned ? { reference: null, failed: false } : current));
          owned.release();
        };
      }, [sessionId, retain]);
      return held;
    }

    /** @returns the live Session snapshot of one retained reference, or null. */
    function useSessionSnapshot(reference) {
      const subscribe = React.useCallback(
        (listener) => {
          if (!reference) return () => {};
          try {
            return reference.binding.session.subscribe(listener);
          } catch (error) {
            return () => {};
          }
        },
        [reference],
      );
      const getSnapshot = React.useCallback(() => {
        if (!reference) return null;
        try {
          return reference.binding.session.getSnapshot();
        } catch (error) {
          return null;
        }
      }, [reference]);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /** Keep the embedded Conversation on Chat; stage work never replaces it. */
    function FixedChatConversationView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    /**
     * Render the shared Conversation content for the workbench Session.
     * The embedded variant is the seat the right Sidebar chat uses: composer,
     * question cards and approvals all come from the host Conversation.
     */
    function WorkbenchChat({ renderFactorySlot }) {
      return h(
        'div',
        { className: 'dshwb-chatBody' },
        renderFactorySlot(
          'conversation.content',
          { variant: 'embedded', phase: 'active', hero: false },
          { slots: { views: FixedChatConversationView } },
        ),
      );
    }

    /**
     * Keep one failed Conversation occurrence from blanking the whole page:
     * a stale Session reference would otherwise crash the `main` entry.
     */
    class ChatBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.warn('workbench: the embedded conversation failed to render:', error);
      }

      componentDidUpdate(previous) {
        if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
      }

      render() {
        if (this.state.failed) return this.props.fallback;
        return this.props.children;
      }
    }

    /** Bind the retained reference to the workbench Conversation slot. */
    function ChatPane({ sessionId, reference, failed, copy, SessionProvider, renderSlot }) {
      if (!sessionId) {
        return h('div', { className: 'dshwb-chatEmpty' }, [
          h(Icon, { key: 'icon', name: 'chat', size: 22 }),
          h('strong', { key: 'title' }, copy.chat.emptyTitle),
          h('span', { key: 'hint' }, copy.chat.emptyHint),
        ]);
      }
      if (typeof SessionProvider !== 'function' || typeof renderSlot !== 'function') {
        return h('div', { className: 'dshwb-chatEmpty' }, h('span', null, copy.chat.unavailable));
      }
      if (!reference) {
        return failed
          ? h('div', { className: 'dshwb-chatEmpty' }, h('span', null, copy.chat.unavailable))
          : h('div', { className: 'dshwb-chatEmpty' }, [
              h('div', { key: 'spin', className: 'dshwb-spinner' }),
              h('span', { key: 'hint' }, copy.chat.connecting),
            ]);
      }
      return h(
        ChatBoundary,
        {
          resetKey: sessionId,
          fallback: h('div', { className: 'dshwb-chatEmpty' }, h('span', null, copy.chat.unavailable)),
        },
        h(
          'div',
          { className: 'dshwb-chatHost' },
          h(
            SessionProvider,
            {
              session: reference,
              empty: () =>
                h('div', { className: 'dshwb-chatEmpty' }, h('span', null, copy.chat.unavailable)),
            },
            renderSlot('workbench.chat', {}),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------
     * Mid-stage change composer
     * ---------------------------------------------------------------- */

    function ModifyComposer({ copy, busy, onModify }) {
      const [text, setText] = React.useState('');
      const [steer, setSteer] = React.useState(false);
      const send = async () => {
        if (!text.trim()) return;
        const sent = await onModify(text.trim(), steer);
        if (sent) {
          setText('');
          setSteer(false);
        }
      };
      return h(
        'div',
        { className: 'dshwb-composer' },
        h(
          'div',
          { key: 'head', className: 'dshwb-composerHead' },
          h('span', { key: 'title', className: 'dshwb-composerTitle' }, [
            h(Icon, { key: 'icon', name: 'chat', size: 14 }),
            copy.modify.title,
          ]),
          h('span', { key: 'hint', className: 'dshwb-composerHintText' }, copy.modify.hint),
        ),
        h('textarea', {
          key: 'input',
          className: 'dshwb-input dshwb-composerInput',
          rows: 3,
          value: text,
          placeholder: copy.modify.placeholder,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              send();
            }
          },
        }),
        h(
          'div',
          { key: 'quick', className: 'dshwb-quickRow' },
          [copy.modify.quick1, copy.modify.quick2, copy.modify.quick3].map((hint, index) =>
            h(
              'button',
              {
                key: index,
                type: 'button',
                className: 'dshwb-chip',
                onClick: () => setText(hint),
              },
              hint,
            ),
          ),
        ),
        h(
          'div',
          { key: 'actions', className: 'dshwb-composerActions' },
          h(
            'label',
            { className: 'dshwb-steer' },
            h('input', {
              type: 'checkbox',
              checked: steer,
              onChange: (event) => setSteer(event.target.checked),
            }),
            copy.modify.steer,
          ),
          h(
            Button,
            {
              kind: 'primary',
              size: 'sm',
              onClick: send,
              disabled: busy !== '' || !text.trim(), disabledReason: busy !== '' ? '正在发送操作，请等待完成。' : '请先填写要发送的修改要求。',
            },
            h(Icon, { name: 'send', size: 13 }),
            steer ? copy.action.sendSteer : copy.action.send,
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------
     * Full page
     * ---------------------------------------------------------------- */

    /**
     * One draggable column boundary.
     *
     * Pointer handling lives in the page (it owns the CSS variables), so this
     * stays a presentational separator: a 12px hit strip in the grid gap with
     * an accessible name, keyboard nudging and double-click reset.
     */
    function SplitHandle({ side, value, limits, dragging, label, onDragStart, onNudge, onReset }) {
      return h(
        'div',
        {
          className: `dshwb-split dshwb-split-${side}${dragging ? ' dshwb-splitActive' : ''}`,
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': label,
          'aria-valuemin': limits.min,
          'aria-valuemax': limits.max,
          'aria-valuenow': Math.round(value),
          tabIndex: 0,
          title: label,
          onPointerDown: onDragStart,
          onDoubleClick: onReset,
          onKeyDown: (event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              onNudge(-16);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              onNudge(16);
            } else if (event.key === 'Home') {
              event.preventDefault();
              onReset();
            }
          },
        },
        h('span', { className: 'dshwb-splitLine', 'aria-hidden': true }),
      );
    }

    function useArtifactReview(boardId, root, refreshVersion) {
      const [review, setReview] = React.useState({ phase: 'loading', data: null, error: '' });
      React.useEffect(() => {
        if (!boardId) return undefined;
        let alive = true;
        let pending = false;
        const controller = new AbortController();
        setReview({ phase: 'loading', data: null, error: '' });
        const refresh = async () => {
          if (pending) return;
          pending = true;
          try {
            const response = await apiFetch(ARTIFACTS_URL, { cache: 'no-store', signal: controller.signal });
            const payload = await readApiJson(response);
            if (!response.ok) throw new Error(payload.message || 'Cannot load artifact versions');
            if (alive && workbenchStore.get().boardId === boardId && workbenchStore.getRoot() === root) {
              workbenchStore.applyReview(payload);
              setReview({ phase: 'ready', data: payload, error: '' });
            }
          } catch (error) {
            if (alive && error.name !== 'AbortError') setReview({ phase: 'error', data: null, error: String(error.message || error) });
          } finally { pending = false; }
        };
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => { alive = false; controller.abort(); clearInterval(timer); };
      }, [boardId, root, refreshVersion]);
      return review;
    }

    function ArtifactReviewPanel({ review, state, stage, localeId, onRefresh, showToast }) {
      const en = localeId === 'en';
      const [downloading, setDownloading] = React.useState(false);
      const downloadSnapshot = async (artifact) => {
        setDownloading(true);
        try {
          const response = await apiFetch(`${RAW_URL}?path=${encodeURIComponent(artifact.snapshot)}&name=${encodeURIComponent(artifact.name)}&download=1`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement('a');
          link.href = url; link.download = artifact.name; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { showToast(String(error.message || error), 'error'); }
        finally { setDownloading(false); }
      };
      const data = review.data?.boardId === state.boardId ? review.data : null;
      const hashes = data?.stages[stage]?.hashes || {};
      const history = (data?.history || []).filter((entry) => entry.stage === stage);
      const warning = state.artifactStorage?.warning;
      return h(Card, { className: 'dshwb-artifactReview' }, [
        h(SectionHead, { key: 'head', icon: 'doc', title: en ? 'This round · document versions' : '本轮文档与确认版本',
          desc: state.artifactStorage ? `${state.artifactStorage.directory}/documents/` : '',
          extra: h(Button, { size: 'xs', onClick: onRefresh }, en ? 'Refresh' : '刷新版本') }),
        warning ? h('p', { key: 'warning', role: 'status', className: 'dshwb-banner dshwb-bannerWarn' }, warning) : null,
        state.stageData[stage].needsReview ? h('p', { key: 'stale', role: 'status', className: 'dshwb-banner dshwb-bannerWarn' },
          en ? 'Approval is stale. Review the current documents before confirming again.' : '原确认已失效，请核对当前文档后重新确认；历史快照仍保留。') : null,
        review.phase !== 'ready' ? h('p', { key: 'status', role: 'status' }, review.error || (en ? 'Loading versions…' : '正在加载文档版本…')) : null,
        h('ul', { key: 'files' }, Object.entries(hashes).map(([name, digest]) =>
          h('li', { key: name }, `${name} · ${digest ? `SHA-256 ${digest.slice(0, 12)}` : (en ? 'Missing' : '本轮尚未生成')}`))),
        h('p', { key: 'hint', className: 'dshwb-hint' }, en
          ? 'Confirmation saves immutable snapshots of these versions. Later changes require review.'
          : '确认阶段将保存以上版本的不可变快照。文档变更或删除后，本阶段及后续确认需重新复核。'),
        h('details', { key: 'history' }, [
          h('summary', { key: 'title' }, `${en ? 'Approval history' : '确认历史'} (${history.length})`),
          history.length ? history.map((entry) => h('div', { key: entry.id, className: 'dshwb-versionEntry' }, [
            h('strong', { key: 'time' }, formatTime(entry.confirmedAt, localeId)),
            entry.note ? h('p', { key: 'note' }, entry.note) : null,
            ...entry.artifacts.map((artifact) => h('div', { key: artifact.name },
              h(Button, { size: 'xs', disabled: downloading, disabledReason: '正在下载该版本，请等待下载完成。', onClick: () => downloadSnapshot(artifact),
                title: artifact.contentHash }, `${artifact.name} · v${artifact.revision} ↓`))),
          ])) : h('p', { key: 'empty' }, en ? 'No version-bound approvals yet.' : '暂无绑定版本的确认记录。'),
        ]),
      ]);
    }

    /** Paragraph anchors keep exact source line ranges, including fenced code blocks. */
    function paragraphAnchors(text) {
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      const blocks = []; let start = -1; let fence = '';
      const flush = (end) => {
        if (start >= 0) blocks.push({ startLine: start + 1, endLine: end,
          quote: lines.slice(start, end).join('\n') });
        start = -1;
      };
      for (let i = 0; i < lines.length; i++) {
        const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
        if (marker && !fence) { flush(i); start = i; fence = marker[1]; }
        else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) { fence = ''; flush(i + 1); }
        else if (!fence && lines[i].trim() === '') flush(i);
        else if (start < 0) start = i;
      }
      flush(lines.length);
      return blocks;
    }

    function buildReviewFeedback(data, directory) {
      const comments = data.comments.filter((item) => item.status === 'open');
      if (!comments.length) return '';
      const selected = comments.slice(0, 20);
      return `请按以下文档审阅意见修改本轮产出，不要自行确认阶段或标记评论已解决。\n文档：${directory}/documents/${data.name}\n当前 SHA-256：${data.contentHash}\n完整评论：${directory}/reviews.json\n` +
        selected.map((item, index) => `\n${index + 1}. 评论 ${item.id}（${item.stale ? '引用旧版本，请先定位当前对应内容' : '当前版本'}，L${item.anchor.startLine}–${item.anchor.endLine}）\n原文：${item.anchor.quote.slice(0, 800)}\n修改意见：${item.text.slice(0, 1200)}`).join('\n') +
        (comments.length > selected.length ? `\n另有 ${comments.length - selected.length} 条，请读取完整评论文件。` : '') +
        '\n完成后说明各条处理结果，保留未解决问题，由用户重新审阅并确认。';
    }

    function useDocumentReview(name, boardId, refreshVersion, approvalId) {
      const [result, setResult] = React.useState({ phase: 'loading', data: null, error: '' });
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        apiFetch(`${REVIEW_URL}?path=${encodeURIComponent(name)}&approval=${encodeURIComponent(approvalId)}`, {
          cache: 'no-store', signal: controller.signal,
        }).then(async (response) => {
          const payload = await readApiJson(response);
          if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
          if (alive && payload.boardId === boardId) setResult({ phase: 'ready', data: payload, error: '' });
        }).catch((error) => {
          if (alive && error.name !== 'AbortError') setResult({ phase: 'error', data: null, error: String(error.message || error) });
        });
        return () => { alive = false; controller.abort(); };
      }, [name, boardId, refreshVersion, approvalId, tick]);
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 5000);
        return () => clearInterval(timer);
      }, []);
      return { ...result, refresh: () => setTick((value) => value + 1) };
    }

    function DiffView({ diff, en }) {
      if (!diff.added && !diff.removed) return h('p', { className: 'dshwb-reviewEmpty' }, diff.formatOnly
        ? (en ? 'Text is unchanged, but line-ending bytes differ. Review before confirming.' : '文本内容一致，但换行字节不同，请核对后确认。')
        : (en ? 'No changes from this confirmed version.' : '与所选确认版本一致。'));
      return h('div', { className: 'dshwb-diffView' }, [
        h('p', { key: 'count', className: 'dshwb-diffCount' }, `+${diff.added} / −${diff.removed} ${en ? 'lines' : '行'}`),
        diff.simplified ? h('p', { key: 'simple', role: 'status' }, en ? 'Large edit shown as a block replacement.' : '变更较大，按整段替换展示。') : null,
        h('table', { key: 'rows', className: 'dshwb-diffTable', 'aria-label': en ? 'Document changes' : '文档差异' },
          h('thead', null, h('tr', null, h('th', null, en ? 'Old' : '旧'), h('th', null, en ? 'New' : '新'), h('th', null, en ? 'Change' : '变更'))),
          h('tbody', null, diff.rows.map((row, index) => row.kind === 'skip'
            ? h('tr', { key: index, className: 'dshwb-diff-skip' }, h('td', { colSpan: 3 }, en ? `${row.count} unchanged lines` : `省略 ${row.count} 行未变内容`))
            : h('tr', { key: index, className: `dshwb-diff-${row.kind}` },
              h('td', null, row.oldLine), h('td', null, row.newLine),
              h('td', null, h('span', { className: 'dshwb-diffSign' }, row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '), h('code', null, row.text))))),
        ),
        diff.truncated ? h('p', { key: 'truncated', role: 'status' }, en ? 'Display limited to 2500 rows. Download the full document to finish review.' : '差异超过 2500 行，当前仅展示部分；请下载全文完成审阅。') : null,
      ]);
    }

    function readReviewDraft(key) {
      try {
        const data = JSON.parse(localStorage.getItem(key) || '{}');
        return { text: typeof data.text === 'string' ? data.text.slice(0, 4000) : '',
          anchor: isRecord(data.anchor) && typeof data.anchor.quote === 'string' && data.anchor.quote.length <= 12000 && Number.isSafeInteger(data.anchor.startLine) && Number.isSafeInteger(data.anchor.endLine) ? data.anchor : null, contentHash: str(data.contentHash) };
      } catch { return { text: '', anchor: null, contentHash: '' }; }
    }

    function ReviewDocument({ name, state, refreshVersion, onRequestChanges, showToast, localeId, managerMode }) {
      const en = localeId === 'en';
      const [mode, setMode] = React.useState('content');
      const [approvalId, setApprovalId] = React.useState('');
      const review = useDocumentReview(name, state.boardId, refreshVersion, approvalId);
      const draftKey = `dsh-workbench:review-draft:${workbenchStore.getRoot()}:${state.boardId}:${name}`;
      const [draft, setDraft] = React.useState(() => readReviewDraft(draftKey));
      const [busy, setBusy] = React.useState(false);
      const [showResolved, setShowResolved] = React.useState(false);
      const formRef = React.useRef(null);
      React.useEffect(() => {
        try {
          if (draft.text || draft.anchor) localStorage.setItem(draftKey, JSON.stringify(draft));
          else localStorage.removeItem(draftKey);
        } catch { /* Draft remains in memory if storage is unavailable. */ }
      }, [draftKey, draft]);
      const data = review.data && (!approvalId || review.data.baseline?.approvalId === approvalId) ? review.data : null;
      const mutation = async (body) => {
        setBusy(true);
        try {
          const response = await apiFetch(REVIEW_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const payload = await readApiJson(response);
          if (!response.ok) throw new Error(payload.message || 'Review failed');
          review.refresh();
          return true;
        } catch (error) { showToast(String(error.message || error), 'error'); return false; }
        finally { setBusy(false); }
      };
      const addComment = async (event) => {
        event.preventDefault();
        if (!draft.anchor || !draft.text.trim() || busy) return;
        if (await mutation({ action: 'add', name, contentHash: draft.contentHash, anchor: draft.anchor, text: draft.text })) {
          setDraft({ text: '', anchor: null, contentHash: '' });
        }
      };
      const selectParagraph = (anchor) => {
        setDraft((current) => ({ ...current, anchor, contentHash: data.contentHash }));
        setTimeout(() => { formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); formRef.current?.querySelector('textarea')?.focus(); }, 0);
      };
      if (!data) return h('div', { className: 'dshwb-docBody', role: 'status' }, [
        h('p', { key: 'message' }, review.error || (en ? 'Loading review…' : '正在加载审阅内容…')),
        review.error ? h(Button, { key: 'retry', onClick: review.refresh }, en ? 'Retry' : '重试') : null,
      ]);
      const open = data.comments.filter((item) => item.status === 'open');
      return h('div', { className: 'dshwb-reviewDocument' }, [
        h('div', { key: 'toolbar', className: 'dshwb-reviewToolbar' }, [
          h('div', { key: 'modes', className: 'dshwb-tabGroup', role: 'group', 'aria-label': en ? 'Review view' : '审阅视图' },
            ['content', 'diff'].map((value) => h('button', { key: value, type: 'button', 'aria-pressed': mode === value,
              onClick: () => setMode(value) }, value === 'content' ? (en ? 'Document' : '文档与评论') : (en ? 'Changes' : '版本差异')))),
          h('span', { key: 'hash', className: 'dshwb-hint', title: data.contentHash }, `SHA-256 ${data.contentHash.slice(0, 12)}`),
        ]),
        mode === 'diff' ? h('div', { key: 'baseline', className: 'dshwb-reviewBaseline' }, [
          h('label', { key: 'label' }, en ? 'Compare with ' : '对比基准 ',
            h('select', { value: approvalId, onChange: (event) => setApprovalId(event.target.value) },
              h('option', { value: '' }, en ? 'Most recent confirmation' : '最近一次确认'),
              data.versions.map((item) => h('option', { key: item.approvalId, value: item.approvalId }, `v${item.revision} · ${formatTime(item.confirmedAt, localeId)}`)))),
          !data.baseline ? h('p', { key: 'first', className: 'dshwb-hint' }, en ? 'First review: the full document is shown as added.' : '尚无确认版本，全文作为新增内容展示。') : null,
        ]) : null,
        h('div', { key: 'body', className: 'dshwb-reviewBody' }, mode === 'diff'
          ? h(DiffView, { diff: data.diff, en })
          : paragraphAnchors(data.text).slice(0, 500).map((anchor) => h('section', {
              key: anchor.startLine, className: `dshwb-reviewParagraph${draft.anchor?.startLine === anchor.startLine ? ' dshwb-reviewParagraphSelected' : ''}`,
              'aria-label': `L${anchor.startLine}–${anchor.endLine}`,
            }, [
              h(MarkdownView, { key: 'text', text: anchor.quote, kind: 'markdown' }),
              h(Button, { key: 'comment', type: 'button', className: 'dshwb-paragraphComment', disabled: anchor.quote.length > 12000 || anchor.endLine - anchor.startLine > 300, disabledReason: '本段超过评论范围（12000 字或 300 行），请拆分文档后再评论。',
                onClick: () => selectParagraph(anchor), 'aria-label': `${en ? 'Comment on lines' : '评论段落'} ${anchor.startLine}–${anchor.endLine}` }, en ? 'Comment' : '评论此段'),
            ]))),
        paragraphAnchors(data.text).length > 500 && mode === 'content' ? h('p', { key: 'limit', role: 'status' }, en ? 'Showing the first 500 paragraphs. Download the full document for the rest.' : '当前展示前 500 段，请下载全文审阅其余内容。') : null,
        h('section', { key: 'comments', className: 'dshwb-reviewComments', 'aria-label': en ? 'Review comments' : '审阅评论' }, [
          h('div', { key: 'head', className: 'dshwb-reviewCommentsHead' }, [
            h('strong', { key: 'title' }, `${en ? 'Unresolved comments' : '未解决评论'} · ${open.length}`),
            h(Button, { key: 'send', size: 'xs', disabled: busy || !open.length, disabledReason: busy ? '正在处理评论，请等待完成。' : '请先添加至少一条未解决的审阅评论。',
              onClick: async () => { setBusy(true); try { await onRequestChanges(buildReviewFeedback(data, state.artifactStorage.directory)); } finally { setBusy(false); } } }, managerMode ? '请管家处理修改意见' : en ? 'Request changes from Agent' : '将修改意见发给 Agent'),
          ]),
          h('p', { key: 'hint', className: 'dshwb-hint' }, managerMode ? '点击正文旁的「评论此段」提出修改。修改完成后，请核对内容，并将已经处理好的意见标记为已解决。' : en ? 'Select a paragraph to comment. Agent responses do not resolve comments automatically.' : '点击正文旁的「评论此段」定位原文。Agent 修改完成后，请核对并手动解决评论。'),
          h('label', { key: 'filter', className: 'dshwb-hint' }, h('input', { type: 'checkbox', checked: showResolved, onChange: (event) => setShowResolved(event.target.checked) }), en ? ' Show resolved comments' : ' 显示已解决评论'),
          ...data.comments.filter((item) => showResolved || item.status === 'open').map((item) => h('article', { key: item.id, className: 'dshwb-reviewComment' }, [
            h('div', { key: 'status', className: 'dshwb-hint' }, `${item.status === 'open' ? (en ? 'Open' : '未解决') : (en ? 'Resolved' : '已解决')} · L${item.anchor.startLine}–${item.anchor.endLine}`),
            item.stale ? h('p', { key: 'stale', className: 'dshwb-commentStale' }, en ? 'Anchored to an older version. Check the corresponding text before resolving.' : '引用的是旧版本原文，请核对当前对应内容后再解决。') : null,
            h('blockquote', { key: 'quote', title: item.anchor.quote }, item.anchor.quote.slice(0, 400)),
            h('p', { key: 'text', className: 'dshwb-commentText' }, item.text),
            h(Button, { key: 'resolve', size: 'xs', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => mutation({ action: item.status === 'open' ? 'resolve' : 'reopen', id: item.id, revision: item.revision }) },
              item.status === 'open' ? (en ? 'Mark resolved' : '标记已解决') : (en ? 'Reopen' : '重新打开')),
          ])),
          draft.anchor ? h('form', { key: 'form', ref: formRef, onSubmit: addComment, className: 'dshwb-commentForm' }, [
            h('strong', { key: 'anchor' }, `${en ? 'Comment on' : '评论'} L${draft.anchor.startLine}–${draft.anchor.endLine}`),
            h('blockquote', { key: 'quote' }, draft.anchor.quote.slice(0, 400)),
            draft.contentHash !== data.contentHash ? h('p', { key: 'changed', role: 'alert' }, en ? 'Document changed. Select the current paragraph again; your draft is kept.' : '文档已更新，请重新选择当前段落；评论草稿已保留。') : null,
            h('label', { key: 'input' }, en ? 'Requested change' : '修改意见', h('textarea', { className: 'dshwb-input dshwb-textarea', rows: 3, maxLength: 4000,
              value: draft.text, onChange: (event) => setDraft((current) => ({ ...current, text: event.target.value })) })),
            h(Button, { key: 'submit', kind: 'primary', type: 'submit', disabled: busy || !draft.text.trim() || draft.contentHash !== data.contentHash, disabledReason: busy ? '正在保存评论，请等待完成。' : !draft.text.trim() ? '请先填写评论内容。' : '文档版本已变化，请重新选择当前版本的段落后评论。' }, en ? 'Save comment' : '保存评论'),
            h(Button, { key: 'cancel', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => setDraft({ text: '', anchor: null, contentHash: '' }) }, en ? 'Discard draft' : '放弃草稿'),
          ]) : null,
        ]),
      ]);
    }

    function WorkspaceDrawer({ open, onClose, title, children, busy = false }) {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (open && ref.current && !ref.current.open) ref.current.showModal();
        if (!open && ref.current?.open) ref.current.close();
      }, [open]);
      return h('dialog', { ref, className: 'dshwb-settingsDrawer', onClose,
        onCancel: (event) => { event.preventDefault(); onClose(); } }, [
        h('header', { key: 'header' }, h('h2', null, title), h(Button, { type: 'button', className: 'dshwb-chatOpen', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: onClose, 'aria-label': title + ' · close / 关闭' }, '×')),
        h('div', { key: 'content', className: 'dshwb-settingsContent' }, children),
      ]);
    }

    function ConversationDock({ state, copy, localeId, stage, chatPane, onOpenSession, hasSession }) {
      const name = requirementName(state);
      const requirement = localeId === 'en' ? `Current requirement: ${name} · Round ${state.round || 1}` : `当前需求：${name} · 第 ${state.round || 1} 轮`;
      return h('aside', { className: 'dshwb-dock', 'aria-label': copy.chat.tab },
        h('div', { className: 'dshwb-chatPane' }, [
          h('div', { key: 'head', className: 'dshwb-chatHead' }, [
            h('div', { key: 'context', className: 'dshwb-chatContext' }, [
              h('div', { key: 'role', className: 'dshwb-chatRole' }, [
                h('span', { key: 'scope', className: 'dshwb-chatScope' }, copy.team.roles[stage]),
                h('span', { key: 'hint', className: 'dshwb-chatHint' }, copy.chat.tab),
              ]),
              h('span', { key: 'requirement', className: 'dshwb-chatRequirement', title: requirement,
                'data-testid': 'chat-requirement', 'aria-live': 'polite' }, requirement),
            ]),
            h(Button, { key: 'open', type: 'button', className: 'dshwb-chatOpen', onClick: onOpenSession, disabled: !hasSession, disabledReason: '请先开始当前阶段，创建会话后再打开完整对话。' }, copy.chat.openFullShort),
          ]),
          h('div', { key: 'body', className: 'dshwb-chatMount' }, chatPane),
        ]));
    }

    const KNOWLEDGE_LABELS = { FR: '功能需求', NFR: '非功能需求', AC: '验收标准', ADR: '设计决策', TASK: '实现任务', TC: '测试用例', EV: '验证证据' };
    const KNOWLEDGE_STATUS = { draft: '草稿', accepted: '已确认', deprecated: '已废弃' };

    function useKnowledgeResource(url, boardId, refreshVersion) {
      const [result, setResult] = React.useState({ phase: 'loading', data: null, error: '' });
      React.useEffect(() => {
        let alive = true; const controller = new AbortController();
        const timer = setTimeout(() => {
          apiFetch(url, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
            const payload = await readApiJson(response);
            if (!response.ok) throw new Error(payload.message || '读取失败');
            if (alive && (payload.boardId || payload.preview?.boardId) === boardId) setResult({ phase: 'ready', data: payload, error: '' });
          }).catch((error) => {
            if (alive && error.name !== 'AbortError') setResult((current) => ({ ...current, phase: 'error', error: String(error.message || error) }));
          });
        }, 180);
        return () => { alive = false; clearTimeout(timer); controller.abort(); };
      }, [url, boardId, refreshVersion]);
      return result;
    }

    async function knowledgeMutation(body) {
      const response = await apiFetch(KNOWLEDGE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await readApiJson(response);
      if (!response.ok) throw new Error(payload.message || '知识保存失败');
      return payload;
    }

    function KnowledgeEntryForm({ initial, onSave, onCancel, busy }) {
      const [draft, setDraft] = React.useState(() => ({ type: 'FR', id: '', title: '', body: '', status: 'draft', refs: [], evidence: { command: '', outcome: 'unknown', codeRef: '' }, ...initial }));
      const [refsText, setRefsText] = React.useState((initial?.refs || []).join(', '));
      const patch = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
      const evidence = (key, value) => setDraft((current) => ({ ...current, evidence: { ...current.evidence, [key]: value } }));
      return h('form', { className: 'dshwb-knowledgeForm', onSubmit: (event) => { event.preventDefault(); onSave({ ...draft, refs: refsText.split(/[\s,，;；]+/).filter(Boolean) }); } }, [
        h('h3', { key: 'title' }, initial?.id ? `编辑 ${initial.id}` : '新增知识条目'),
        h('div', { key: 'identity', className: 'dshwb-knowledgeFields' }, [
          h('label', { key: 'type' }, '类型', h('select', { value: draft.type, disabled: Boolean(initial?.id), onChange: (event) => patch('type', event.target.value) },
            Object.entries(KNOWLEDGE_LABELS).map(([id, label]) => h('option', { key: id, value: id }, `${id} · ${label}`)))),
          h('label', { key: 'id' }, '编号', h('input', { className: 'dshwb-input', value: draft.id, disabled: Boolean(initial?.id), maxLength: 65, required: true, placeholder: `${draft.type}-001`, onChange: (event) => patch('id', event.target.value) })),
        ]),
        h('label', { key: 'name' }, '知识标题', h('input', { className: 'dshwb-input', value: draft.title, maxLength: 200, required: true, onChange: (event) => patch('title', event.target.value) })),
        h('label', { key: 'body' }, '知识正文', h('textarea', { className: 'dshwb-input dshwb-textarea', rows: 4, maxLength: 6000, value: draft.body, onChange: (event) => patch('body', event.target.value) })),
        h('label', { key: 'refs' }, '引用编号（逗号或空格分隔）', h('input', { className: 'dshwb-input', value: refsText, placeholder: 'FR-001, AC-001', onChange: (event) => setRefsText(event.target.value) })),
        h('label', { key: 'status' }, '知识状态', h('select', { value: draft.status, onChange: (event) => patch('status', event.target.value) }, Object.entries(KNOWLEDGE_STATUS).map(([id, label]) => h('option', { key: id, value: id }, label)))),
        draft.type === 'EV' ? h('fieldset', { key: 'evidence' }, [
          h('legend', { key: 'legend' }, '证据记录（不会自动执行测试）'),
          h('label', { key: 'command' }, '执行命令', h('input', { className: 'dshwb-input', value: draft.evidence?.command || '', onChange: (event) => evidence('command', event.target.value) })),
          h('label', { key: 'result' }, '记录结果', h('select', { value: draft.evidence?.outcome || 'unknown', onChange: (event) => evidence('outcome', event.target.value) },
            [['unknown', '未提供结果'], ['not-run', '未执行'], ['passed', '通过'], ['failed', '失败']].map(([value, title]) => h('option', { key: value, value }, title)))),
          h('label', { key: 'code' }, '代码版本 / 提交', h('input', { className: 'dshwb-input', value: draft.evidence?.codeRef || '', onChange: (event) => evidence('codeRef', event.target.value) })),
        ]) : null,
        h('div', { key: 'actions', className: 'dshwb-knowledgeActions' }, h(Button, { type: 'submit', kind: 'primary', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。' }, '保存知识'), h(Button, { onClick: onCancel, disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。' }, '取消')),
      ]);
    }

    function ContextInspector({ state, stage, refreshVersion, onChanged, showToast }) {
      const resource = useKnowledgeResource(`${CONTEXT_URL}?stage=${stage}`, state.boardId, refreshVersion);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [actual, setActual] = React.useState(null);
      const [reference, setReference] = React.useState({ path: '', name: '', status: 'draft' });
      const payload = resource.data, preview = payload?.preview;
      const choices = draft || (preview ? { revision: preview.selectionRevision, budget: preview.budget,
        included: preview.options.filter((o) => o.selected).map((o) => o.id), excluded: preview.options.filter((o) => !o.selected).map((o) => o.id) } : null);
      const change = (id, checked) => setDraft((current) => {
        const next = current || choices;
        return { ...next, included: checked ? [...new Set([...next.included, id])] : next.included.filter((value) => value !== id),
          excluded: checked ? next.excluded.filter((value) => value !== id) : [...new Set([...next.excluded, id])] };
      });
      const save = async (body) => {
        setBusy(true);
        try { const saved = await knowledgeMutation(body); if (body.action === 'selection') setDraft(null); else setDraft((current) => current ? { ...current, revision: saved.revision } : null); onChanged(); showToast('知识与上下文选择已保存。', 'success'); return true; }
        catch (error) { showToast(String(error.message || error), 'error'); return false; }
        finally { setBusy(false); }
      };
      const showActual = async () => {
        try {
          const response = await apiFetch(`${CONTEXT_URL}?id=${encodeURIComponent(payload.latest.id)}`, { cache: 'no-store' });
          const data = await readApiJson(response); if (!response.ok) throw new Error(data.message || '读取失败'); setActual(data);
        } catch (error) { showToast(String(error.message || error), 'error'); }
      };
      return h('div', { className: 'dshwb-contextInspector' }, [
        h('h3', { key: 'title' }, '本次 Agent 将使用的资料'),
        h('p', { key: 'hint', className: 'dshwb-hint' }, '阶段任务发送前会按保存的选择重建清单。正文是参考资料，草稿不会被当成已确认事实；原生聊天手工输入不经过此清单。'),
        resource.error ? h('p', { key: 'error', role: 'alert' }, resource.error) : null,
        !preview ? h('p', { key: 'loading', role: 'status' }, '正在计算上下文…') : [
          h('label', { key: 'budget', className: 'dshwb-contextBudget' }, '上下文字符预算（不是精确 Token 数）', h('input', {
            type: 'number', min: 4000, max: 60000, value: choices.budget,
            onChange: (event) => setDraft({ ...choices, budget: Number(event.target.value) }),
          })),
          h('p', { key: 'used', className: 'dshwb-hint' }, `当前预览 ${preview.chars} / ${preview.budget} 字符${draft ? ' · 有未保存的选择；下方预览仍对应已保存配置' : ''}`),
          ...preview.options.map((item) => h('label', { key: item.id, className: 'dshwb-contextSource' }, [
            h('input', { key: 'check', type: 'checkbox', checked: choices.included.includes(item.id), disabled: item.status === 'deprecated' || item.missing,
              onChange: (event) => change(item.id, event.target.checked) }),
            h('span', { key: 'info' }, h('strong', null, item.name), h('small', null, `${KNOWLEDGE_STATUS[item.status]} · ${item.reason}`),
              item.path ? h('code', null, item.path) : null),
          ])),
          !preview.options.length ? h('p', { key: 'empty' }, '当前还没有可选资料；生成阶段文档或添加知识后会显示。') : null,
          h('div', { key: 'save', className: 'dshwb-knowledgeActions' },
            h(Button, { kind: 'primary', disabled: busy || !draft, disabledReason: busy ? '正在保存上下文，请等待完成。' : '请先调整上下文勾选，再保存选择。', onClick: () => save({ action: 'selection', stage, ...choices }) }, '保存上下文选择'),
            h(Button, { disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => { setDraft(null); onChanged(); } }, '放弃选择并刷新')),
          preview.warnings.length ? h('details', { key: 'warnings', open: true, className: 'dshwb-knowledgeWarnings' },
            h('summary', null, `需要核对 ${preview.warnings.length} 项`), h('ul', null, preview.warnings.map((warning, index) => h('li', { key: index }, warning)))) : null,
          h('details', { key: 'entries' }, h('summary', null, '查看选用、节选与排除清单'),
            h('ul', { className: 'dshwb-contextEntries' }, preview.entries.map((entry, index) => h('li', { key: `${entry.id}:${index}` },
              `${entry.id} · ${{ full: '全文', excerpt: '节选', metadata: '仅引用', excluded: '已排除' }[entry.mode]}${entry.redacted ? '（已移除废弃段落）' : ''} · ${entry.chars} 字符${entry.reason ? ` · ${entry.reason}` : ''}`)))),
          h('details', { key: 'prompt' }, h('summary', null, '预览上下文正文'), h('pre', { className: 'dshwb-contextText' }, preview.prompt)),
          payload.latest ? h('div', { key: 'latest', className: 'dshwb-knowledgeNotice' }, [
            h('strong', { key: 'label' }, '上次实际构建的清单'),
            h('p', { key: 'time' }, `${formatTime(payload.latest.createdAt, 'zh')} · ${payload.latest.current ? '输入版本未变' : '资料或选择已变化，下次发送将重建'}`),
            h(Button, { key: 'view', size: 'xs', onClick: showActual }, '查看上次清单'),
          ]) : h('p', { key: 'notSent', className: 'dshwb-hint' }, '尚未构建实际发送清单。预览不会触发模型调用。'),
          actual ? h('details', { key: actual.id, open: true }, h('summary', null, `实际清单 ${actual.id.slice(0, 8)}`),
            h('code', null, actual.path), h('pre', { className: 'dshwb-contextText' }, actual.prompt)) : null,
          h('details', { key: 'reference' }, h('summary', null, '添加 / 更新项目参考资料'),
            h('form', { className: 'dshwb-knowledgeForm', onSubmit: async (event) => {
              event.preventDefault(); if (await save({ action: 'reference', revision: preview.selectionRevision, ...reference })) setReference({ path: '', name: '', status: 'draft' });
            } }, [
              h('label', { key: 'path' }, '参考资料相对路径', h('input', { className: 'dshwb-input', required: true, value: reference.path, placeholder: 'docs/业务规则.md', onChange: (event) => setReference({ ...reference, path: event.target.value }) })),
              h('label', { key: 'name' }, '资料名称', h('input', { className: 'dshwb-input', value: reference.name, onChange: (event) => setReference({ ...reference, name: event.target.value }) })),
              h('label', { key: 'status' }, '资料审核状态', h('select', { value: reference.status, onChange: (event) => setReference({ ...reference, status: event.target.value }) },
                Object.entries(KNOWLEDGE_STATUS).map(([value, title]) => h('option', { key: value, value }, title)))),
              h('p', { key: 'hint', className: 'dshwb-hint' }, '只读取你指定的本项目 Markdown / 文本。内容变化后会退回草稿；废弃资料保持排除。'),
              h(Button, { key: 'submit', type: 'submit', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。' }, '保存参考资料'),
            ])),
        ],
      ]);
    }

    function KnowledgePanel({ state, stage, refreshVersion, showToast, onOpenDocument }) {
      const [tab, setTab] = React.useState('knowledge');
      const [query, setQuery] = React.useState('');
      const [type, setType] = React.useState('');
      const [status, setStatus] = React.useState('');
      const [tick, setTick] = React.useState(0);
      const [selectedId, setSelectedId] = React.useState('');
      const [editor, setEditor] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [link, setLink] = React.useState({ to: '', relation: 'supports' });
      const refresh = () => setTick((value) => value + 1);
      const token = `${refreshVersion}:${tick}`;
      const resource = useKnowledgeResource(`${KNOWLEDGE_URL}?q=${encodeURIComponent(query)}&type=${type}&status=${status}`, state.boardId, token);
      const data = resource.data;
      const selected = data?.nodes.find((item) => item.id === selectedId);
      const related = selected ? data.links.filter((edge) => edge.from === selected.id || edge.to === selected.id) : [];
      const focus = (id) => { setQuery(id); setType(''); setStatus(''); setSelectedId(id); };
      const mutate = async (body) => {
        setBusy(true);
        try { await knowledgeMutation({ ...body, revision: data.revision }); refresh(); showToast('知识已保存。', 'success'); return true; }
        catch (error) { showToast(String(error.message || error), 'error'); return false; }
        finally { setBusy(false); }
      };
      return h('div', { className: 'dshwb-knowledgePanel' }, [
        h('div', { key: 'nav', className: 'dshwb-knowledgeNav' },
          h('div', { className: 'dshwb-tabGroup', role: 'group', 'aria-label': '知识视图' },
            h('button', { type: 'button', 'aria-pressed': tab === 'knowledge', onClick: () => setTab('knowledge') }, '知识与关联'),
            h('button', { type: 'button', 'aria-pressed': tab === 'context', onClick: () => setTab('context') }, '本次上下文')),
          h(Button, { size: 'xs', onClick: refresh }, '刷新知识')),
        resource.error ? h('p', { key: 'error', role: 'alert' }, resource.error) : null,
        tab === 'context' ? h(ContextInspector, { key: 'context', state, stage, refreshVersion: token, onChanged: refresh, showToast }) : [
          h('p', { key: 'summary', className: 'dshwb-knowledgeSummary' }, data ? `${data.stats.nodes} 条知识 · ${data.stats.links} 条关联 · ${data.stats.gaps} 项追溯缺口` : '正在建立知识视图…'),
          h('p', { key: 'explain', className: 'dshwb-hint' }, '从正式文档的 FR / AC / ADR / TASK / TC / EV 编号提取，普通提及不会新增条目。文档与手工知识分别标明来源；证据结果是记录值，不代表系统已重跑验证。'),
          h('div', { key: 'search', className: 'dshwb-knowledgeFilters' }, [
            h('input', { key: 'q', className: 'dshwb-input', 'aria-label': '搜索知识与资料', placeholder: '搜索编号、标题、正文或来源', value: query, onChange: (event) => setQuery(event.target.value) }),
            h('select', { key: 'type', 'aria-label': '知识类型筛选', value: type, onChange: (event) => setType(event.target.value) }, h('option', { value: '' }, '全部类型'), Object.entries(KNOWLEDGE_LABELS).map(([value, title]) => h('option', { key: value, value }, `${value} · ${title}`))),
            h('select', { key: 'status', 'aria-label': '知识状态筛选', value: status, onChange: (event) => setStatus(event.target.value) }, h('option', { value: '' }, '全部状态'), Object.entries(KNOWLEDGE_STATUS).map(([value, title]) => h('option', { key: value, value }, title))),
          ]),
          h('div', { key: 'actions', className: 'dshwb-knowledgeActions' }, h(Button, { kind: 'primary', size: 'xs', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => setEditor({}) }, '新增知识'),
            h(Button, { size: 'xs', onClick: () => setTab('context') }, '检查 Agent 上下文')),
          editor ? h(KnowledgeEntryForm, { key: editor.id || 'new', initial: editor, busy,
            onCancel: () => setEditor(null), onSave: async (node) => { if (await mutate({ action: 'upsert', node })) { setEditor(null); focus(node.id.toUpperCase()); } } }) : null,
          data?.issues.length ? h('details', { key: 'gaps', className: 'dshwb-knowledgeWarnings' },
            h('summary', null, `知识与追溯检查（${data.issues.length}${data.issues.length === 100 ? '+' : ''}）`),
            h('ul', null, data.issues.map((issue, index) => h('li', { key: index }, issue.id ? h('button', { type: 'button', onClick: () => focus(issue.id) }, issue.message) : issue.message)))) : null,
          data && !data.total ? h('p', { key: 'empty', className: 'dshwb-reviewEmpty' }, '没有匹配条目。可调整筛选，或先在正式文档中定义编号，再刷新。') : null,
          h('ul', { key: 'nodes', className: 'dshwb-knowledgeList' }, (data?.nodes || []).map((node) => h('li', { key: node.id },
            h('button', { type: 'button', 'aria-pressed': selected?.id === node.id, onClick: () => setSelectedId(selected?.id === node.id ? '' : node.id) },
              h('strong', null, node.id), h('span', null, node.title), h('small', null, `${KNOWLEDGE_STATUS[node.status]} · ${node.origin === 'manual' ? '手工录入' : '文档提取'}${node.stale ? ' · 来源需复核' : ''}`))))),
          data?.total > 100 ? h('p', { key: 'limit', className: 'dshwb-hint' }, `共 ${data.total} 条，显示前 100 条；请细化搜索。`) : null,
          selected ? h('section', { key: selected.id, className: 'dshwb-knowledgeDetail', 'aria-label': '知识详情' }, [
            h('h3', { key: 'title' }, `${selected.id} · ${selected.title}`),
            h('div', { key: 'tools', className: 'dshwb-knowledgeActions' },
              selected.origin === 'manual' ? h(Button, { size: 'xs', onClick: () => setEditor(selected) }, '编辑知识') : null,
              h(Button, { size: 'xs', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => mutate({ action: selected.status === 'deprecated' ? 'restore' : 'deprecate', id: selected.id }) }, selected.status === 'deprecated' ? '恢复为草稿 / 重新索引' : '标记已废弃')),
            selected.source ? h('div', { key: 'source', className: 'dshwb-knowledgeSource' }, [
              h('code', { key: 'path' }, `${selected.source.path}:L${selected.source.startLine}–${selected.source.endLine}`),
              h('small', { key: 'hash' }, `SHA-256 ${selected.source.contentHash.slice(0, 12)}${selected.source.revision ? ` · 文档 v${selected.source.revision}` : ''}`),
              h(Button, { key: 'open', size: 'xs', onClick: () => onOpenDocument(selected.source) }, '打开来源文档'),
            ]) : h('p', { key: 'manual', className: 'dshwb-hint' }, `手工条目版本 v${selected.revision}`),
            h('pre', { key: 'body', className: 'dshwb-knowledgeText' }, selected.body),
            selected.evidence ? h('p', { key: 'evidence', className: 'dshwb-knowledgeNotice' }, `证据记录：${selected.evidence.outcome} · 命令：${selected.evidence.command || '未提供'} · 代码：${selected.evidence.codeRef || '未提供'}`) : null,
            h('h4', { key: 'links-title' }, '关联链'),
            ...related.map((edge) => h('div', { key: edge.id, className: 'dshwb-knowledgeEdge' },
              h('button', { type: 'button', onClick: () => focus(edge.from) }, edge.from), h('span', null, ` — ${edge.relation} → `), h('button', { type: 'button', onClick: () => focus(edge.to) }, edge.to),
              edge.origin === 'manual' ? h(Button, { size: 'xs', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => mutate({ action: 'unlink', id: edge.id }) }, '移除关联') : null)),
            !related.length ? h('p', { key: 'no-links', className: 'dshwb-hint' }, '尚未建立关联。') : null,
            h('form', { key: 'link', className: 'dshwb-knowledgeLinkForm', onSubmit: async (event) => { event.preventDefault(); if (await mutate({ action: 'link', from: selected.id, to: link.to.trim().toUpperCase(), relation: link.relation })) setLink({ to: '', relation: 'supports' }); } },
              h('input', { className: 'dshwb-input', 'aria-label': '关联目标编号', placeholder: '目标编号，如 AC-001', required: true, value: link.to, onChange: (event) => setLink({ ...link, to: event.target.value }) }),
              h('select', { 'aria-label': '关联关系', value: link.relation, onChange: (event) => setLink({ ...link, relation: event.target.value }) }, ['supports', 'satisfies', 'implements', 'verifies', 'supersedes'].map((relation) => h('option', { key: relation, value: relation }, relation))),
              h(Button, { type: 'submit', size: 'xs', disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。' }, '建立关联')),
          ]) : null,
          (data?.sourceMatches || []).length ? h('details', { key: 'source-search', open: true }, h('summary', null, `资料全文命中（${data.sourceMatches.length}）`),
            data.sourceMatches.map((source) => h('article', { key: source.id, className: 'dshwb-knowledgeSource' }, h('strong', null, source.name), h('code', null, source.path), h('p', null, source.excerpt)))) : null,
        ],
      ]);
    }

    const MANAGER_URL = '/workbench/manager';
    const MANAGER_STAGE_TITLES = { spec: '需求说明书', design: '设计方案', build: '制作与运行说明', verify: '测试报告', ship: '交付清单', proposal: '开题报告' };
    /** @returns whether one line asks the user something. */
    function isQuestionLine(line) {
      const trimmed = String(line || '').trim();
      if (trimmed === '') return false;
      return (
        /[？?]\s*$/.test(trimmed) ||
        /^(请问|请确认|请告诉|请选择|请补充|是否|需要你|要不要|能否|可以告诉|麻烦你)/.test(trimmed)
      );
    }

    /** Split a long paragraph into sentence groups so it is not one wall of text. */
    function paragraphChunks(text) {
      const value = String(text || '').trim();
      if (value.length <= 80) return [value];
      const sentences = value.split(/(?<=[。！？；!?;])/).map((part) => part.trim()).filter(Boolean);
      if (sentences.length < 3) return [value];
      const chunks = [];
      for (let index = 0; index < sentences.length; index += 2) {
        chunks.push(sentences.slice(index, index + 2).join(''));
      }
      return chunks;
    }

    /**
     * Turn one manager reply into readable blocks: headings, lists, short
     * paragraphs and highlighted questions.
     */
    function managerBlocks(text) {
      const lines = String(text || '').split('\n');
      const blocks = [];
      let paragraph = [];
      let items = [];
      let ordered = false;
      const flushParagraph = () => {
        const value = paragraph.join('\n').trim();
        if (value !== '') {
          for (const chunk of paragraphChunks(value)) blocks.push({ kind: 'para', text: chunk });
        }
        paragraph = [];
      };
      const flushItems = () => {
        if (items.length > 0) blocks.push({ kind: 'list', ordered, items: items.slice() });
        items = [];
      };
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
          flushParagraph();
          continue;
        }
        if (isQuestionLine(trimmed)) {
          flushParagraph();
          flushItems();
          blocks.push({ kind: 'question', text: trimmed });
          continue;
        }
        const item = /^(\d+[.)]|[-*·])\s+(.*)$/.exec(trimmed);
        if (item !== null) {
          flushParagraph();
          if (items.length > 0 && ordered !== /^\d/.test(item[1])) flushItems();
          ordered = /^\d/.test(item[1]);
          items.push(item[2].trim());
          continue;
        }
        const heading = /^\*\*([^*]+)\*\*[:：]?$/.exec(trimmed);
        if (heading !== null) {
          flushParagraph();
          flushItems();
          blocks.push({ kind: 'heading', text: heading[1].trim() });
          continue;
        }
        flushItems();
        paragraph.push(trimmed);
      }
      flushParagraph();
      flushItems();
      return blocks;
    }

    /**
     * Break one suggested instruction into readable lines: instructions are
     * written as clauses separated by ; or newlines, which read badly as one
     * dense paragraph.
     */
    function proposalLines(text) {
      const value = String(text || '').trim();
      if (value === '') return [];
      const parts = value
        .split(/[；;。]\s*|[\n]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length <= 1) return [];
      return parts.map((part) => (/[。！？.!?]$/.test(part) ? part : `${part}。`));
    }

    /** @returns React nodes with simple **bold** runs turned into <strong>. */
    function inlineBold(text) {
      return String(text || '')
        .split(/(\*\*[^*]+\*\*)/g)
        .filter((part) => part !== '')
        .map((part, index) =>
          part.startsWith('**') && part.endsWith('**') && part.length > 4
            ? h('strong', { key: index }, part.slice(2, -2))
            : part,
        );
    }

    /** @returns a short, human duration for the manager stepper. */
    function formatDuration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      if (total < 60) return `${total} 秒`;
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
    }

    const MANAGER_JOB_LABELS = { queued: '已接下，正在安排', creating: '正在准备', submitting: '正在提交', running: '正在处理', cancelling: '正在停止', uncertain: '需要核对执行情况', completed: '沟通完成', awaiting_review: '文档已生成，等你阅读', needs_input: '还有内容需要补充', failed: '处理未完成', cancelled: '已停止' };
    function WorkbenchPage(props) {
      const [mode, setMode] = React.useState('manager');
      return mode === 'manager'
        ? h(PersonalManagerPage, { ...props, onDetails: () => setMode('details') })
        : h(DetailedWorkbenchPage, { ...props, onManager: () => setMode('manager') });
    }

    const TEMPLATES_URL = '/workbench/templates';
    const TEMPLATE_TITLES = { spec: '需求说明书', design: '设计方案', build: '制作与运行说明', verify: '测试报告', ship: '交付清单' };

    /**
     * Delivery-template card: pick a built-in template or upload one, confirm the
     * detected sections, then render the stage's delivery files.
     */
    function TemplatePanel({ state, stage, scenario = 'product', refreshKey, showToast, download }) {
      const [data, setData] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [tick, setTick] = React.useState(0);
      const [preview, setPreview] = React.useState(null);
      const [report,setReport]=React.useState(null);
      const [mappings,setMappings]=React.useState({});
      const [warnings,setWarnings]=React.useState([]);
      const [extraStage, setExtraStage] = React.useState('');
      const fileRef = React.useRef(null);
      const extraInfo = (data && data.extras) || {};
      const extras = (data && data.scenarios && data.scenarios[scenario] && data.scenarios[scenario].extras) || [];
      const activeStage = extraStage !== '' ? extraStage : stage;
      const gateKey = (extraInfo[activeStage] && extraInfo[activeStage].after) || activeStage;
      const stageConfirmed = Boolean(state.stageData[gateKey] && state.stageData[gateKey].confirmed);
      React.useEffect(() => {setPreview(null);setReport(null);setMappings({});setWarnings([]);}, [activeStage]);
      React.useEffect(() => setExtraStage(''), [stage]);
      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        apiFetch(TEMPLATES_URL, { cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((payload) => { if (alive) setData(payload); })
          .catch((error2) => { if (alive && error2.name !== 'AbortError') setError(String(error2.message || error2)); });
        return () => { alive = false; controller.abort(); };
      }, [refreshKey, tick]);
      const post = async (body) => {
        setBusy(body.action);
        setError('');
        try {
          const response = await apiFetch(TEMPLATES_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({...body,...(['preflight','render'].includes(body.action)?{mappings}:{})}),
          });
          const payload = await response.json().catch(() => ({}));
          if(payload.report)setReport(payload.report);
          if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
          if(payload.stages)setData(payload);
          if(payload.files)setWarnings(payload.files.warnings || []);
          if(!['preflight','render'].includes(body.action))setReport(null);
          setTick((value) => value + 1);
        } catch (error2) {
          setError(String(error2.message || error2));
        } finally {
          setBusy('');
        }
      };
      const loadPreview = async (row) => {
        setBusy('preview');
        setError('');
        try {
          const response = await apiFetch(TEMPLATES_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'preview', stage: activeStage, template: row.id }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
          setPreview({ ...payload, name: row.name });
        } catch (error2) {
          setError(String(error2.message || error2));
        } finally {
          setBusy('');
        }
      };
      const upload = async (file) => {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(new Error('读取文件失败'));
          reader.readAsDataURL(file);
        });
        await post({ action: 'upload', stage: activeStage, name: file.name, data: base64 });
      };
      const rows = (data && data.stages && data.stages[activeStage]) || [];
      const selectedId = (data && data.selected && data.selected[activeStage]) || 'default-simple';
      const confirmed = data && data.confirmed && data.confirmed[activeStage];
      const delivery = (data && data.delivery && data.delivery[activeStage]) || [];

      return h('div', { className: 'dshpm-template' }, [
        h('div', { key: 'head', className: 'dshpm-templateHead' }, [
          h('strong', { key: 'title' }, `${activeStage === stage ? '交付模板' : '附加文档'} · ${TEMPLATE_TITLES[activeStage] || (extraInfo[activeStage] && extraInfo[activeStage].title) || ''}`),
          confirmed
            ? h('span', { key: 'badge', className: 'dshpm-templateBadge' }, '已确认')
            : h('span', { key: 'badge', className: 'dshpm-templateBadge dshpm-templateBadgeWait' }, '未确认'),
        ]),
        extras.length > 0
          ? h('div', { key: 'extra', className: 'dshwb-tabGroup', role: 'group', 'aria-label': '阶段文档与附加文档' },
              [
                h('button', { key: stage, type: 'button', 'aria-pressed': activeStage === stage, onClick: () => setExtraStage('') }, TEMPLATE_TITLES[stage] || '阶段文档'),
                ...extras.map((key) =>
                  h('button', { key, type: 'button', 'aria-pressed': activeStage === key, onClick: () => setExtraStage(key) },
                    (extraInfo[key] && extraInfo[key].title) || key)),
              ])
          : null,
        h('p', { key: 'hint', className: 'dshwb-hint' },
          '生成前请检查内容来源与缺口。PDF 优先使用 Word 转换，否则使用本机中文字体生成内容版 PDF；演示文稿可下载可编辑 PPTX。'),
        rows.length === 0
          ? h('p', { key: 'loading', className: 'dshwb-hint' }, '正在读取模板…')
          : h('div', { key: 'list', className: 'dshpm-templateList' }, rows.map((row) => {
              const titles = (row.sections || []).map((section) => section.title);
              const brief = titles.slice(0, 3).join(' / ') + (titles.length > 3 ? ' …' : '');
              return h('div', { key: row.id, className: 'dshpm-templateRow' }, [
                h('label', { key: 'pick', className: 'dshpm-templatePick' }, [
              h('input', { key: 'radio', type: 'radio', name: `tpl-${activeStage}`, checked: selectedId === row.id, onChange: () => post({ action: 'select', stage: activeStage, template: row.id }) }),
              h('span', { key: 'name' }, row.name),
                  h('span', { key: 'meta', className: 'dshwb-hint' }, `${titles.length} 节 · ${row.kind === 'uploaded' ? '上传' : '内置'}`),
                ]),
                h('span', { key: 'brief', className: 'dshpm-templateBrief', title: titles.join(' / ') }, brief),
                h(Button, { key: 'preview', size: 'xs', disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => loadPreview(row) }, '预览'),
              ]);
            })),
        h('div', { key: 'actions', className: 'dshpm-actions' }, [
          h(Button, { key: 'confirm', disabled: busy !== '' || Boolean(confirmed && confirmed.template === selectedId), disabledReason: busy !== '' ? '正在处理模板，请等待完成。' : '当前模板已经确认，可以检查内容与来源。', onClick: () => post({ action: 'confirm', stage: activeStage, template: selectedId }) }, '确认这份模板'),
          h(Button,{key:'preflight',disabled:busy!=='' || !confirmed || !stageConfirmed, disabledReason:busy!=='' ? '正在处理模板，请等待完成。' : !confirmed ? '请先点击「确认这份模板」。' : '请先阅读并确认对应阶段的文档。',onClick:()=>post({action:'preflight',stage:activeStage})},'检查内容与来源'),
          h(Button, { key: 'render', kind: 'primary', disabled: busy !== '' || !confirmed || !stageConfirmed || !report?.canFinalize, disabledReason: busy !== '' ? '正在处理模板，请等待完成。' : !confirmed ? '请先点击「确认这份模板」。' : !stageConfirmed ? '请先阅读并确认对应阶段的文档。' : !report ? '请先点击「检查内容与来源」。' : report.gaps.length ? '请先补齐检查报告中的缺口并重新检查；也可以明确生成标记草稿。' : '来源选择已变化，请重新点击「检查内容与来源」。', onClick: () => post({ action: 'render', stage: activeStage }) }, activeStage === 'proposal' ? '生成开题报告' : '生成本阶段交付件'),
          h(Button, { key: 'upload', disabled: busy !== '', disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => fileRef.current && fileRef.current.click() }, '上传模板'),
        ]),
        report ? h('section',{key:'report',className:'dshpm-templatePreview','aria-label':'交付检查结果'},[
          h('strong',{key:'title'},report.canFinalize?'内容检查通过，可以生成正式交付件':'还有内容需要补充'),
          h('ul',{key:'gaps'},report.gaps.map((gap,i)=>h('li',{key:i},`${gap.section}：${gap.reason}`))),
          ...(report.sourceMap || []).map(row=>h('label',{key:row.id,style:{display:'block',margin:'8px 0'}},row.section+' · 来源 ',
            h('select',{className:'dshwb-input',value:mappings[row.id] || row.source || '',disabled:busy!=='',onChange:e=>{setMappings({...mappings,[row.id]:e.target.value});setReport({...report,canFinalize:false});}},[
              h('option',{key:'auto',value:''},row.status==='whole'?'合并全部已确认正文':'自动匹配 / 待补充'),
              ...(report.candidates || []).map(c=>h('option',{key:c.id,value:c.id},c.source+' · '+c.heading))
            ]))),
          h('p',{key:'hint',className:'dshwb-hint'},'修改来源后请重新检查。缺少正文时，请在成果中补充并重新确认文档。回答管家或检查通过都不会自动确认文档。'),
          report.gaps.length ? h(Button,{key:'draft',disabled:busy!=='',disabledReason:'正在处理交付件，请等待完成。',onClick:()=>post({action:'render',stage:activeStage,draft:true})},'保留缺口，生成标记草稿'):null
        ]):null,
        ...warnings.map((warning,i)=>h('p',{key:'warning'+i,role:'status'},warning)),
        h('input', { key: 'file', type: 'file', accept: '.docx,.md,.txt', style: { display: 'none' }, ref: fileRef, onChange: (event) => { const file = event.target.files && event.target.files[0]; event.target.value = ''; if (file) upload(file); } }),
        preview
          ? h('div', { key: 'preview', className: 'dshpm-templatePreview' }, [
              h('div', { key: 'head', className: 'dshpm-templatePreviewHead' }, [
                h('strong', { key: 'title' }, `预览：${preview.name || preview.title}`),
                h(Button, { key: 'close', size: 'xs', onClick: () => setPreview(null) }, '关闭'),
              ]),
              h('p', { key: 'hint', className: 'dshwb-hint' }, '下面是交付件的结构预览：章节顺序按模板，具体内容会在阶段确认后填入。'),
              h(MarkdownView, { key: 'md', text: preview.markdown, kind: 'md' }),
              preview.sourceText
                ? h('details', { key: 'source' }, [h('summary', null, '查看上传模板原文'), h('pre', { key: 'pre' }, preview.sourceText)])
                : null,
            ])
          : null,
        !stageConfirmed ? h('p', { key: 'gate', className: 'dshwb-hint' }, activeStage === stage ? '阶段文档确认后，才能生成交付件。' : `${TEMPLATE_TITLES[gateKey] || '前置文档'}确认后，才能生成${(extraInfo[activeStage] && extraInfo[activeStage].title) || '这份文档'}。`) : null,
        error ? h('p', { key: 'error', className: 'dshpm-templateError' }, error) : null,
        delivery.length > 0
          ? h('div', { key: 'files', className: 'dshpm-files' }, delivery.map((file) => h('article', { key: file.path }, [
              h('strong', { key: 'name' }, file.kind==='json'?'版本与来源记录':file.name),
              h('span',{key:'version',className:'dshwb-hint'},(file.version || '').replace(/T(\d{2})-(\d{2})-(\d{2}).*/, ' $1:$2:$3 UTC')),
              file.kind === 'html'
                ? h(Button, { key: 'print', onClick: () => window.open(`/workbench/raw?path=${encodeURIComponent(file.path)}`, '_blank') }, '打印 / 另存为 PDF')
                : h(Button, { key: 'download', onClick: () => download(file.path, file.name) }, '下载'),
            ])))
          : null,
      ]);
    }

    // Render host-parsed Markdown as React elements. Never insert model HTML.
    function MessageMarkdown({ nodes, fallback }) {
      if (!nodes) return h('p', null, fallback || '');
      function tree(tokens, inline = false) {
        const root = [], stack = [{ children:root }];
        tokens.forEach((token,index)=>{
          const current=stack[stack.length-1].children;
          if(token.type.endsWith('_close')) { if(stack.length>1)stack.pop(); return; }
          if(token.type.endsWith('_open')) {
            const allowed=['p','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','strong','em','s','a'];
            const tag=token.type==='link_open'?'a':allowed.includes(token.tag)?token.tag:'span';
            const node={tag,children:[],key:index,props:tag==='a' && token.href ? {href:token.href,target:'_blank',rel:'noopener noreferrer'}:{}};
            current.push(node);stack.push(node);return;
          }
          if(token.type==='inline')current.push(...tree(token.children || [],true));
          else if(token.type==='fence' || token.type==='code_block')current.push(h('pre',{key:index},h('code',null,token.text)));
          else if(token.type==='code_inline')current.push(h('code',{key:index},token.text));
          else if(token.type==='hardbreak')current.push(h('br',{key:index}));
          else if(token.type==='softbreak')current.push('\n');
          else if(token.type==='hr')current.push(h('hr',{key:index}));
          else if(token.type==='text')current.push(token.text);
        });
        const render=n=>n && n.tag ? h(n.tag,{key:n.key,...n.props},n.children.map(render)):n;
        return root.map(render);
      }
      return h('div',{className:'dshpm-markdown'},tree(nodes));
    }
    function ManagerQuestion({ block, locked, lockedReason, onAnswer, compact = false }) {
      const [answer,setAnswer]=React.useState('');
      return h('section',{className:'dshpm-question','aria-label':'管家需要你回答的问题'},[
        h(MessageMarkdown,{key:'text',nodes:block.nodes,fallback:block.text}),
        block.answer ? h('p',{key:'answered'},'已回答：'+block.answer) : h('div',{key:'input'},[
          h('div',{key:'options',className:'dshpm-actions'},(block.options || []).map(option=>h(Button,{key:option,disabled:locked,disabledReason:lockedReason,onClick:()=>onAnswer(block.id,option)},option))),
          h(compact && block.options?.length?'details':'div',{key:'custom',className:'dshpm-customAnswer'},[
            compact && block.options?.length?h('summary',{key:'summary'},'我有其他回答'):null,
            h('textarea',{key:'answer',className:'dshwb-input',rows:2,maxLength:2000,value:answer,disabled:locked,'aria-label':'你的回答',onChange:e=>setAnswer(e.target.value)}),
            h(Button,{key:'send',kind:'primary',disabled:locked || !answer.trim(),disabledReason:locked ? lockedReason : '请先填写回答，或直接点击一个选项。',onClick:async()=>{if(await onAnswer(block.id,answer))setAnswer('');}},'提交回答')
          ])
        ])
      ]);
    }
    function ManagerMessage({ message, locked, lockedReason, onAnswer, onDocument, hideQuestions = false }) {
      const blocks=(message.blocks || [{type:'paragraph',text:message.text}]).filter(b=>!hideQuestions || b.type!=='question' || b.answer);
      return h('article',{className:'dshpm-message dshpm-message-'+message.role},[
        h('strong',{key:'role'},message.role==='user'?'你':'项目管家'),
        ...blocks.map((block,index)=>{
          if(block.type==='question')return h(ManagerQuestion,{key:index,block,locked,lockedReason,onAnswer});
          if(block.type==='document')return h(Button,{key:index,onClick:()=>onDocument(block.stage)},'查看成果 · '+block.name);
          if(block.type==='details')return h('details',{key:index},h('summary',null,block.title || '查看详细说明'),h(MessageMarkdown,{nodes:block.nodes,fallback:block.text}));
          if(block.type==='list')return h('section',{key:index},block.title ? h('strong',null,block.title):null,h('ul',null,block.items.map((item,i)=>h('li',{key:i},h(MessageMarkdown,{nodes:block.itemNodes?.[i],fallback:item})))));
          return h('div',{key:index,className:block.type==='summary'?'dshpm-summary':''},h(MessageMarkdown,{nodes:block.nodes,fallback:block.text}));
        })
      ]);
    }

    const MANAGER_ACTIONS = new Set(['open_setup','answer','dispatch','show_progress','open_review','open_results','reconnect','recheck','cancel','open_session','compose','prepare_first','package','download_package']);
    function supportsManagerPresentation(p) {
      return p?.schemaVersion===1 && Number.isInteger(p.revision) && typeof p.title==='string' && typeof p.description==='string' && Array.isArray(p.blockingReasons) && MANAGER_ACTIONS.has(p.primaryAction?.kind) && typeof p.primaryAction.label==='string' && Array.isArray(p.secondaryActions) && p.secondaryActions.every(a=>MANAGER_ACTIONS.has(a.kind) && typeof a.label==='string') && (p.primaryAction.kind!=='answer' || (p.question?.id===p.primaryAction.questionId && typeof p.question.text==='string'));
    }
    function managerModePreference(saved) {return saved==='full'?'full':'simple';}
    function readManagerMode() {try {return managerModePreference(localStorage.getItem('dshwb-manager-mode'));} catch {return 'simple';}}
    function ManagerActionCard({ presentation:p, busy, onAction, onAnswer, cancelInComposer = false }) {
      const primary=p.primaryAction;
      return h('section',{className:'dshpm-actionCard','aria-label':'管家的下一步'},[
        h('p',{key:'eyebrow',className:'dshpm-eyebrow'},'项目管家 · 下一步'),
        h('h2',{key:'title'},p.title),h('p',{key:'description'},p.description),
        p.instruction?h('div',{key:'instruction',className:'dshpm-planText'},h(MessageMarkdown,{fallback:p.instruction})):null,
        p.phase==='needs_info' && p.question?h(ManagerQuestion,{key:p.question.id,block:p.question,compact:true,locked:busy,lockedReason:'正在提交回答，请等待完成。',onAnswer}):h(Button,{key:'primary',kind:'primary',disabled:busy || primary.enabled===false,disabledReason:busy?'正在提交操作，请等待完成。':primary.reason || p.blockingReasons[0],onClick:()=>onAction(primary,p.revision)},primary.label),
        h('div',{key:'secondary',className:'dshpm-actions'},p.secondaryActions.filter(a=>!cancelInComposer || a.kind!=='cancel').map(a=>h(Button,{key:a.kind,disabled:busy || a.enabled===false,disabledReason:busy?'正在提交操作，请等待完成。':a.reason,onClick:()=>onAction(a,p.revision)},a.label)))
      ]);
    }

    // Keep the latest decision in the conversation, while respecting a reader scrolling back.
    function ManagerThread({messages,presentation,busy,locked,lockedReason,onAction,onAnswer,onDocument,progress}) {
      const viewport=React.useRef(null);
      const following=React.useRef(true);
      const [away,setAway]=React.useState(false);
      const latest=()=>{const el=viewport.current;if(el){el.scrollTop=el.scrollHeight;following.current=true;setAway(false);}};
      React.useEffect(()=>{if(following.current)latest();},[messages.at(-1)?.id,presentation.phase,presentation.relatedQuestionId,presentation.primaryAction.proposalId,!!progress]);
      return h('div',{className:'dshpm-thread'},[
        h('div',{key:'log',className:'dshpm-messages',ref:viewport,role:'log','aria-label':'管家对话记录',onScroll:e=>{const el=e.currentTarget;following.current=el.scrollHeight-el.scrollTop-el.clientHeight<60;setAway(!following.current);}},[
          ...messages.map(m=>h(ManagerMessage,{key:m.id,message:m,hideQuestions:true,locked,lockedReason,onAnswer,onDocument})),
          h(ManagerActionCard,{key:'next',presentation,busy,onAction,onAnswer,cancelInComposer:true}),
          progress
        ]),
        away?h(Button,{key:'latest',className:'dshwb-btn dshwb-btn-secondary dshwb-btn-md dshpm-latest',onClick:latest},'回到最新进展 ↓'):null
      ]);
    }

    function managerApprovalReason({locked,lockedReason,missing,reviewed,stage,checks,buildChecks}) {
      if(locked)return lockedReason;
      if(missing.length)return `请先补齐并重新检查文档：${missing.join('、')}。`;
      if(stage==='build' && buildChecks.some(c=>!checks.includes(c.id)))return '请先逐项完成实现检查清单。';
      if(!reviewed)return '请先阅读本类文档，并勾选「我已阅读」确认项。';
      return '';
    }
    // One stable subtree in both layouts preserves unfinished document comments.
    function ManagerResultsSheet({simple,open,onClose,children}) {
      const ref=React.useRef(null);
      React.useEffect(()=>{
        const dialog=ref.current;if(!dialog)return;
        if(simple) {
          if(dialog.open && !dialog.matches(':modal'))dialog.close();
          if(open && !dialog.open)dialog.showModal();
          if(!open && dialog.open)dialog.close();
        } else {
          if(dialog.matches(':modal'))dialog.close();
          dialog.setAttribute('open','');
        }
      },[simple,open]);
      return h('dialog',{ref,className:simple?'dshpm-reader':'dshpm-reader-full',role:simple?'dialog':'region','aria-modal':simple&&open?true:undefined,'aria-label':'成果阅读与下载',onCancel:e=>{if(simple){e.preventDefault();onClose();}}},[
        simple?h('header',{key:'reader-head',className:'dshpm-readerHead'},h('strong',null,'成果阅读与下载'),h(Button,{onClick:onClose},'返回对话')):null,
        children
      ]);
    }

    const MANAGER_GOAL_OPTIONS = [
      {mode:'requirements',title:'先把需求写清楚',description:'拿到需求说明书，先决定要做什么。'},
      {mode:'design',title:'给我一份能照着做的方案',description:'拿到需求说明书和实施设计方案。'},
      {mode:'software',title:'帮我做出可以使用的东西',description:'依次准备需求、设计、实现、测试和交付；使用效果仍需核对。'},
    ];
    function ManagerSetup({name,goal,scenario,setName,setGoal,setScenario,busy,onConfigure}) {
      const [step,setStep]=React.useState(1);
      const [mode,setMode]=React.useState('requirements');
      const heading=React.useRef(null);
      React.useEffect(()=>{heading.current?.focus();},[step]);
      const next=()=>{if(!goal.trim() || busy)return;if(!name.trim())setName(goal.trim().slice(0,20));setStep(2);};
      const chosen=MANAGER_GOAL_OPTIONS.find(item=>item.mode===mode);
      return h('form',{className:'dshpm-setup dshpm-welcome',onSubmit:e=>{e.preventDefault();if(step===1)next();else if(!busy && goal.trim() && chosen)onConfigure(mode);}},[
        h('p',{key:'step',className:'dshpm-eyebrow'},step===1?'从一句话开始':'我们先约定要拿到什么'),
        h('h2',{key:'heading',ref:heading,tabIndex:-1},step===1?'你好，今天想一起完成什么？':'这次，先帮你做到哪一步？'),
        step===1?h('div',{key:'idea'},[
          h('details',{key:'name',className:'dshpm-nameOption'},h('summary',null,name?'项目名字：'+name:'给这件事起个名字（可选）'),h('label',null,'项目名字（可选）',h('input',{className:'dshwb-input',maxLength:100,value:name,onChange:e=>setName(e.target.value),placeholder:'例如：小店预约'}))),
          h('label',{key:'goal'},h('span',{className:'dshpm-srOnly'},'说说你的想法'),h('textarea',{className:'dshwb-input',rows:4,maxLength:8000,value:goal,onChange:e=>setGoal(e.target.value),placeholder:'例如：我开了一家理发店，希望客人能在手机上预约。先帮我把需求写清楚。'})),
          h('p',{key:'hint',className:'dshwb-hint'},'像聊天一样说就好，不需要懂技术。接下来会和你确认成果范围。'),
          h('div',{key:'starters',className:'dshpm-starters','aria-label':'想法示例'},[['做一个预约工具','我想做一个小店预约工具，让客人提前选择到店时间。'],['修改现有项目','我有一个现成项目，想增加新功能，并保留原有功能。'],['先整理一份文档','我想先把想法整理成清楚的需求文档，暂时不编写软件。']].map(([label,text])=>h(Button,{key:label,disabled:busy,disabledReason:'正在创建项目，请等待完成。',onClick:()=>setGoal(text)},label))),
          h(Button,{key:'next',kind:'primary',disabled:busy || !goal.trim(),disabledReason:busy?'正在处理，请稍等。':'请先填写你的想法。',onClick:next},'下一步：选择想要的成果')
        ]):h('div',{key:'scope'},[
          h('p',{key:'idea',className:'dshpm-ideaEcho'},goal),
          h('div',{key:'choices',className:'dshpm-goals',role:'group','aria-label':'本次交付目标'},MANAGER_GOAL_OPTIONS.map(option=>h('button',{key:option.mode,type:'button','aria-pressed':mode===option.mode,onClick:()=>setMode(option.mode)},h('strong',null,option.title),h('span',null,option.description)))),
          h('details',{key:'purpose'},h('summary',null,'补充用途（可选）'),h('label',null,'项目用途',h('select',{className:'dshwb-input',value:scenario,onChange:e=>setScenario(e.target.value)},[['product','产品开发'],['thesis','毕业设计'],['pitch','产品概念 / 融资']].map(([value,label])=>h('option',{key:value,value},label)))),h('p',{className:'dshwb-hint'},'用途只影响附加文档选项，不会扩大你刚才选择的交付目标。缺少的真实材料仍需要补充。')),
          h('p',{key:'confirm',className:'dshpm-scopeNotice'},`本次约定：${chosen?.description || ''} 不会自动发布或产生费用。`),
          h('div',{key:'actions',className:'dshpm-actions'},h(Button,{disabled:busy,disabledReason:'正在创建项目，请等待完成。',onClick:()=>setStep(1)},'上一步：修改想法'),h(Button,{kind:'primary',type:'submit',disabled:busy || !goal.trim() || !chosen,disabledReason:busy?'正在创建项目，请等待完成。':'请先填写想法并选择本次成果。'},'确认目标，请管家接下项目'))
        ])
      ]);
    }

    function ManagerLearning({data,locked,reason,mutate,showToast,storageKey,openSession}) {
      const learning=data.learning || {messages:[],paths:[]};
      const [draft,setDraft]=React.useState(()=>{try{return localStorage.getItem(storageKey+':draft') || '';}catch{return '';}});
      const [paths,setPaths]=React.useState(()=>{try{const saved=JSON.parse(localStorage.getItem(storageKey+':paths') || 'null');return Array.isArray(saved)?saved.filter(p=>typeof p==='string').slice(0,12):(learning.paths || []);}catch{return learning.paths || [];}});
      React.useEffect(()=>{try{localStorage.setItem(storageKey+':draft',draft);localStorage.setItem(storageKey+':paths',JSON.stringify(paths));}catch{}},[draft,paths,storageKey]);
      const [sourcesOpen,setSourcesOpen]=React.useState(false);
      const [planStep,setPlanStep]=React.useState(0);
      const [planGoal,setPlanGoal]=React.useState('');
      const [planLevel,setPlanLevel]=React.useState('zero');
      const [planMinutes,setPlanMinutes]=React.useState(20);
      const [lessonId,setLessonId]=React.useState('');
      const [reflecting,setReflecting]=React.useState(false);
      const plan=learning.plan;
      const lesson=plan?.lessons.find(l=>l.id===lessonId) || plan?.lessons.find(l=>l.status!=='self-checked') || plan?.lessons[0];
      React.useEffect(()=>{setLessonId('');setReflecting(false);},[plan?.id]);
      const logRef=React.useRef(null);
      React.useEffect(()=>{logRef.current?.scrollTo(0,logRef.current.scrollHeight);},[learning.messages.at(-1)?.id]);
      const task=data.jobs.findLast(j=>['queued','creating','submitting','running','cancelling','uncertain'].includes(j.status));
      const send=async text=>{
        if(planStep===1){if(!text.trim())return;setPlanGoal(text.trim());setDraft('');setPlanStep(2);return;}
        if(planStep)return;
        if(await mutate({action:reflecting?'learning-reflect':'learn',text,paths,...(reflecting?{planId:plan.id,lessonId:lesson.id}:{})})){setDraft('');setReflecting(false);}
      };
      const catalog=[...new Set([...(learning.catalog?.files || []),...paths])];
      return h('section',{className:'dshpm-conversation dshpm-learning','aria-label':'项目陪学'},[
        h('h2',{key:'title'},'一起学懂这个项目'),
        h('p',{key:'intro',className:'dshwb-hint'},'从一个问题开始，不需要懂技术。讲解会使用你选择的项目资料；学习不会修改产品代码或确认交付成果。'),
        h('div',{key:'sources',className:'dshpm-learningSources'},[
          h(Button,{key:'open',disabled:locked,disabledReason:reason,onClick:async()=>{if(sourcesOpen){setSourcesOpen(false);return;}if(await mutate({action:'learning-sources'}))setSourcesOpen(true);}},sourcesOpen?'收起学习资料':`选择学习资料 · ${paths.length} 份`),
          h('p',{key:'notice',className:'dshwb-hint'},'只有发送问题时才会把选中内容交给当前配置的模型服务。请先确认不含个人资料、密钥或商业敏感内容。未选资料时只能讲通用知识。'),
          sourcesOpen?h('div',{key:'picker',className:'dshpm-sourcePicker'},[
            h('p',{key:'help'},'先选项目说明和一个功能的源码即可，最多 12 份。不会自动把整个项目发给模型。'),
            learning.catalog?.limited?h('p',{key:'limit',role:'status'},'目录较大，只列出部分资料；可先从项目说明开始。'):null,
            !catalog.length?h('p',{key:'empty'},'没有找到适合的文本资料。请确认已选择业务项目文件夹。'):null,
            ...catalog.map(path=>h('label',{key:path},h('input',{type:'checkbox',checked:paths.includes(path),onChange:()=>{if(locked){showToast(reason);return;}if(paths.includes(path))setPaths(paths.filter(p=>p!==path));else if(paths.length>=12)showToast('每次最多选择 12 份资料，请先取消一份。');else setPaths([...paths,path]);}}),h('span',null,path)))
          ]):null
        ]),
        h('div',{key:'plan-entry',className:'dshpm-starters'},h(Button,{disabled:locked || !data.available,disabledReason:reason,onClick:()=>{setReflecting(false);setPlanStep(1);}},plan?'调整学习计划':'帮我安排学习计划')),
        planStep?h('div',{key:'planning',className:'dshpm-notice','aria-label':'安排学习计划'},[
          h('p',{key:'question'},planStep===1?'你希望学到什么程度？可以在下面直接告诉我。':planStep===2?'你目前接触过哪些计算机知识？':'你每天想花多少时间学习？'),
          planStep===1?h('div',{key:'goals',className:'dshpm-starters'},['先理解产品原理','能看懂代码并自己维护'].map(goal=>h(Button,{key:goal,disabled:locked,disabledReason:reason,onClick:()=>{setPlanGoal(goal);setPlanStep(2);}},goal))):planStep===2?h('div',{key:'levels',className:'dshpm-starters'},[['zero','完全没有'],['beginner','接触过一点'],['experienced','有开发经验']].map(([level,label])=>h(Button,{key:level,disabled:locked,disabledReason:reason,onClick:()=>{setPlanLevel(level);setPlanStep(3);}},label))):h('div',{key:'minutes',className:'dshpm-starters'},[10,20,30,60].map(minutes=>h(Button,{key:minutes,disabled:locked,disabledReason:reason,onClick:()=>setPlanMinutes(minutes),'aria-pressed':planMinutes===minutes},`${minutes} 分钟`)),h(Button,{kind:'primary',disabled:locked || !data.available,disabledReason:reason,onClick:async()=>{if(await mutate({action:'learning-plan',goal:planGoal,level:planLevel,minutes:planMinutes,paths})){setPlanStep(0);setDraft('');}}},'请管家安排')),
          h(Button,{key:'cancel',onClick:()=>setPlanStep(0)},'暂时不安排')
        ]):null,
        plan?h('details',{key:'plan',className:'dshpm-learningPlan',open:true},h('summary',null,`${plan.title} · ${plan.lessons.filter(l=>l.status==='self-checked').length}/${plan.lessons.length} 课自评理解`),
          h('p',null,`每天 ${plan.profile.minutes} 分钟 · ${plan.profile.goal}`),
          learning.sourceChanges?.length?h('p',{role:'status'},'部分计划资料已变化或本轮未提供，请重新选择资料或调整计划：'+learning.sourceChanges.join('、')):null,
          h('details',null,h('summary',null,'看看知识地图'),h('ul',null,plan.map.map((topic,i)=>h('li',{key:i},topic)))),
          h('div',{className:'dshpm-starters','aria-label':'课程目录'},plan.lessons.map((l,i)=>h(Button,{key:l.id,'aria-pressed':lesson?.id===l.id,onClick:()=>{setLessonId(l.id);setReflecting(false);}},`${i+1}. ${l.title} · ${{unread:'未读',read:'已阅读','self-checked':'自评理解'}[l.status]}`))),
          lesson?h('div',{className:'dshpm-notice'},h('strong',null,lesson.title),h('p',null,lesson.objective),h('p',{className:'dshwb-hint'},`建议 ${lesson.minutes} 分钟 · ${lesson.sourceIds.length?'按计划资料学习':'待补项目资料，先学通用知识'}`),
            h('div',{className:'dshpm-starters'},h(Button,{disabled:locked || !data.available,disabledReason:reason,onClick:()=>mutate({action:'learning-lesson',planId:plan.id,lessonId:lesson.id,paths})},'讲解这一课'),h(Button,{disabled:locked || lesson.status!=='unread',disabledReason:locked?reason:'这一课已经标记过阅读。',onClick:()=>mutate({action:'learning-progress',planId:plan.id,lessonId:lesson.id,status:'read'})},'我已阅读'),h(Button,{disabled:locked || !data.available,disabledReason:reason,onClick:()=>{setReflecting(true);setDraft('');}},'我来复述'),h(Button,{disabled:locked || lesson.status==='unread' || !lesson.reflectedAt || lesson.status==='self-checked',disabledReason:locked?reason:lesson.status==='self-checked'?'已记录你的自评。':'请先标记已阅读并完成一次复述。',onClick:()=>mutate({action:'learning-progress',planId:plan.id,lessonId:lesson.id,status:'self-checked'})},'我能讲清楚了')),
            h('p',{className:'dshwb-hint'},'自评理解由你主动记录，模型反馈和阅读次数不等于已经掌握。')):null):null,
        reflecting?h('p',{key:'reflection',role:'status'},`试着用自己的话回答：${lesson.question}`):null,
        h('div',{key:'log',ref:logRef,className:'dshpm-messages',role:'log','aria-label':'项目陪学对话'},learning.messages.length?learning.messages.map(m=>h('div',{key:m.id},[
          h(ManagerMessage,{key:'message',message:m,locked:true,lockedReason:'学习问题请直接在下方输入。'}),
          m.evidence?h('details',{key:'evidence',className:'dshpm-learningEvidence'},h('summary',null,'本轮资料与缺口'),h('p',null,'这是该次讲解收到的资料快照，不代表每条结论都已验证；项目更新后请重新提问。'),h('ul',null,m.evidence.sources.map(source=>h('li',{key:source.id},`${source.id} · ${source.path} · 1–${source.lines} 行 · ${source.hash.slice(0,12)}${source.truncated?' · 部分摘录':''}`))),...m.evidence.gaps.map((gap,i)=>h('p',{key:i},gap))):null
        ])):h('p',null,'可以问：“我完全不懂电脑，这个产品是怎么运作的？”也可以先让我做一份原理导读。')),
        task?h('div',{key:'progress',role:'status'},h('p',null,task.kind==='learning'?'管家正在准备讲解…':'开发任务正在处理，可先阅读学习记录。'),task.error?h('p',null,task.error):null,task.sessionId?h(Button,{onClick:()=>openSession(task.sessionId)},'查看处理详情'):null,h(Button,{disabled:!data.available || task.status==='cancelling',disabledReason:!data.available?'执行服务尚未连接。':'已请求停止，请等待结束。',onClick:()=>mutate({action:task.status==='uncertain'?'recheck':'cancel'})},task.status==='uncertain'?'重新检查状态':'停止当前任务')):null,
        !task && data.jobs.at(-1)?.kind==='learning' && ['failed','uncertain','cancelled'].includes(data.jobs.at(-1)?.status)?h('p',{key:'failure',role:'alert'},data.jobs.at(-1).error || '本次学习已停止，可以重新提问。'):null,
        h('div',{key:'starters',className:'dshpm-starters'},[['原理导读','请根据所选资料，带我从零认识这个产品：用途、主要组成和一条操作流程。'],['换个生活例子','我没有听懂刚才的解释，请用更简单的生活例子重新讲。'],['看看设计思路','请解释所选资料能证明的设计思路和取舍，缺少依据的部分请明确说明。']].map(([label,text])=>h(Button,{key:label,disabled:locked || !data.available,disabledReason:reason,onClick:()=>setDraft(text)},label))),
        h('form',{key:'composer',className:'dshpm-composer',onSubmit:e=>{e.preventDefault();send(draft);}},h('label',null,planStep===1?'你希望学到什么程度？':reflecting?'用自己的话讲讲看':'你想弄懂什么？',h('textarea',{className:'dshwb-input',rows:2,value:draft,maxLength:8000,onChange:e=>setDraft(e.target.value),placeholder:'不用担心问得简单，直接说哪里不明白。'})),h(Button,{type:'submit',kind:'primary',disabled:locked || !data.available || !draft.trim() || planStep>1,disabledReason:planStep>1?'请先回答上面的学习安排问题。':!draft.trim()?'请先填写想了解的问题。':reason},planStep===1?'继续安排':reflecting?'请管家看看我的理解':'请管家讲解'))
      ]);
    }

    function PersonalManagerPage(props) {
      const { state, meta, store } = useWorkbench();
      const copy = copyFor(useLocaleId(props.localeRuntime));
      const [managerMode,setManagerMode]=React.useState(readManagerMode);
      const [simpleResultsOpen,setSimpleResultsOpen]=React.useState(false);
      const [showProgress,setShowProgress]=React.useState(false);
      const [learningOpen,setLearningOpen]=React.useState(false);
      const changeManagerMode = value => {setManagerMode(value);try{localStorage.setItem('dshwb-manager-mode',value);}catch{}};
      const [rawData, setData] = React.useState(null);
      const data=rawData?.boardId===state.boardId?rawData:null;
      const simple = managerMode==='simple' && supportsManagerPresentation(data?.presentation);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [draftOwner, setDraftOwner] = React.useState('');
      const [goal, setGoal] = React.useState('');
      const [name, setName] = React.useState('');
      const [scenario, setScenario] = React.useState('product');
      const [tab, setTab] = React.useState('documents');
      const [selectedStage, setSelectedStage] = React.useState('spec');
      const [reviewed, setReviewed] = React.useState(false);
      const [checks, setChecks] = React.useState([]);
      const [retry, setRetry] = React.useState(0);
      const [toast, showToast] = useToast();
      const [revisionText, setRevisionText] = React.useState('');
      const composerRef=React.useRef(null);
      const [focusComposer,setFocusComposer]=React.useState(0);
      React.useEffect(()=>{if(focusComposer)composerRef.current?.focus();},[focusComposer]);
      const pendingRef = React.useRef(false);
      const messagesRef = React.useRef(null);
      const followMessagesRef = React.useRef(true);
      React.useEffect(() => {
        const log = messagesRef.current;
        if (log && followMessagesRef.current) log.scrollTop = log.scrollHeight;
      }, [data?.messages.at(-1)?.id]);
      const identity = `${meta.projectRoot}:${state.boardId}`;
      const identityRef = React.useRef(identity); identityRef.current = identity;
      const draftKey = `dshwb-manager-draft:${identity}`;
      React.useEffect(() => {
        setLearningOpen(false); setData(null); setError(''); setGoal(state.project.goal || ''); setName(state.project.name || '');
        setSelectedStage('spec'); setReviewed(false); setChecks([]); setRevisionText(''); setSimpleResultsOpen(false); setShowProgress(false);
        setDraftOwner(identity);
        try { setDraft(localStorage.getItem(draftKey) || ''); } catch { setDraft(''); }
      }, [identity]);
      React.useEffect(() => { if (draftOwner !== identity) return; try { localStorage.setItem(draftKey, draft); } catch {} }, [draft, draftKey, draftOwner, identity]);
      // Follow the stage that actually waits for the user: when a stage's
      // documents arrive (or one is confirmed and the next begins), focus it so
      // the confirm card is visible without hunting for the right chip.
      const followedStage = React.useRef('');
      React.useEffect(() => {
        const next = data && data.nextStage;
        if (!next || next === followedStage.current) return;
        followedStage.current = next;
        if (next !== selectedStage && (data.outputs || []).some((row) => row.stage === next)) setSelectedStage(next);
      }, [data && data.nextStage, data && data.revision]);
      React.useEffect(() => {
        if (!state.boardId || meta.phase !== 'ready') return;
        let alive = true; let polling = false;
        const controller = new AbortController();
        const refresh = async () => {
          if (polling || pendingRef.current) return; polling = true;
          try {
            const response = await apiFetch(MANAGER_URL, { cache: 'no-store', signal: controller.signal });
            const payload = await readApiJson(response, MANAGER_URL);
            if (alive && !pendingRef.current && identityRef.current === identity) {
              setData(current => !current || payload.revision >= current.revision ? payload : current);
              setError('');
            }
          } catch (err) { if (alive && err.name !== 'AbortError') setError(err.message); }
          finally { polling = false; }
        };
        refresh(); const timer = setInterval(refresh, 2500);
        return () => { alive = false; controller.abort(); clearInterval(timer); };
      }, [identity, meta.phase, retry]);
      React.useEffect(()=>setRevisionText(''),[identity,selectedStage]);
      const selectedHashes = data?.review.stages[selectedStage]?.hashes;
      const hashKey = JSON.stringify(selectedHashes || {});
      React.useEffect(() => { setReviewed(false); setChecks([]); }, [identity, selectedStage, hashKey]);
      const task = data?.jobs.findLast(j => ['queued', 'creating', 'submitting', 'running', 'cancelling', 'uncertain'].includes(j.status));
      const locked = busy || !!task;
      const lockedReason = busy ? '正在提交当前操作，请等待完成。' : task?.status==='uncertain' ? '任务状态需要核对，请先点击「重新检查状态」或停止任务。' : '当前任务尚未结束，请等待完成或先停止这项工作。';
      const managerReason = !data?.available ? '管家执行服务尚未连接，请重启 DSH Host 后再试。' : lockedReason;
      const stopAction=data?.presentation?.secondaryActions?.find(a=>a.kind==='cancel');
      const mutate = async (body) => {
        if (pendingRef.current || !data) return false;
        pendingRef.current = true; setBusy(true);
        const captured = identity;
        try {
          await store.flush();
          const response = await apiFetch(MANAGER_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, revision: data.revision, requestId: uid('manager') }) });
          const payload = await readApiJson(response, MANAGER_URL);
          if (identityRef.current !== captured) return false;
          setData(payload); setError('');
          // Refresh host-owned board revisions before any later browser autosave.
          await store.hydrate(true);
          return true;
        } catch (err) {
          if (identityRef.current === captured) { setError(err.message); setRetry(n => n + 1); }
          return false;
        } finally { pendingRef.current = false; setBusy(false); }
      };
      const message = async (text) => {
        const value = text.trim(); if (!value) return;
        if (await mutate({ action: 'message', text: value })) { setDraft(''); try { localStorage.removeItem(draftKey); } catch {} }
      };
      const download = async (path, filename) => {
        try {
          const response = await apiFetch(`${RAW_URL}?path=${encodeURIComponent(path)}&download=1`);
          if (!response.ok) { await readApiJson(response); return; }
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) { showToast(err.message, 'error'); }
      };
      const selectProject = async () => {
        try { const path = await props.pickDirectory?.(); if (path) { await store.flush(); await store.setRoot(path); } }
        catch (err) { setError(err.message); }
      };
      const newProject = async () => {
        if (busy || pendingRef.current) return;
        setBusy(true);
        try {
          await store.flush();
          const response = await apiFetch(BOARDS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', flow: 'new' }) });
          const payload = await readApiJson(response);
          // A new project starts from a blank slate: the previous requirement's
          // name and goal must not leak into it.
          store.adopt({
            ...payload.state,
            boardId: payload.boardId,
            project: { ...payload.state.project, name: '', goal: '' },
          });
          store.patchProject({ name: '', goal: '' });
          setName(''); setGoal(''); setScenario('product');
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
      };
      const configure = async (mode) => {
        if(!MANAGER_GOAL_OPTIONS.some(item=>item.mode===mode) || !goal.trim()){showToast('请先填写想法并选择本次成果。');return;}
        store.patchProject({ name: name.trim() || '我的项目' });
        await mutate({ action: 'configure', mode, goal, scenario });
      };
      const runManagerAction = async (action,revision) => {
        if(!supportsManagerPresentation(data?.presentation) || revision!==data.revision || !MANAGER_ACTIONS.has(action.kind)) {showToast('安排已变化，请查看最新提示。');return;}
        if(action.enabled===false){showToast(action.reason || '请先完成当前条件。');return;}
        switch(action.kind) {
          case 'open_setup': document.querySelector('.dshpm-setup textarea')?.focus();break;
          case 'compose': document.querySelector('.dshpm-composer textarea')?.focus();break;
          case 'prepare_first': await message('请根据本次交付目标，帮我整理下一步安排；信息不足时先问我。');break;
          case 'dispatch': if(action.proposalId!==data.proposal?.id){showToast('这份安排已变化，请查看最新建议。');return;}await mutate({action:'dispatch',proposalId:action.proposalId});break;
          case 'open_review': setSelectedStage(action.stage);setTab('decisions');setSimpleResultsOpen(true);break;
          case 'open_results':setTab('documents');setSimpleResultsOpen(true);break;
          case 'show_progress':setShowProgress(v=>!v);break;
          case 'reconnect':setRetry(v=>v+1);await store.hydrate(true);break;
          case 'recheck':await mutate({action:'recheck'});break;
          case 'cancel':await mutate({action:'cancel'});break;
          case 'open_session':if(data.jobs.some(j=>j.sessionId===action.sessionId))props.openSession(action.sessionId);break;
          case 'package':await mutate({action:'package'});break;
          case 'download_package':if(data.delivery?.id===action.deliveryId)await download(data.delivery.path,'项目交付文档.zip');break;
        }
      };
      const stage = data?.nextStage || selectedStage;
      const outputs = data?.outputs || [];
      const hasDocument = outputs.some(o => o.stage === selectedStage);
      const selectedNames = {spec:['需求分析阶段.md','需求分析阶段.docx','需求交接.md',...(state.flow==='incremental'?['现状基线.md']:[])],design:['产品实现设计文档.md','设计交接.md'],build:['启动文档.md','部署文档.md','实现交接.md'],verify:['测试案例.md','测试结果.md','验收交接.md'],ship:['交付清单.md']}[selectedStage] || [];
      const missingSelected=selectedNames.filter(name=>!selectedHashes?.[name]);
      const approvalReason=managerApprovalReason({locked,lockedReason,missing:missingSelected,reviewed,stage:selectedStage,checks,buildChecks:data?.buildChecks || []});
      const progress = task && (!simple || showProgress) ? h('div', { key: 'task', className: 'dshpm-notice dshpm-progress', role: 'status' }, [
              h('div', { key: 'head', className: 'dshpm-progressHead' }, [
                h('strong', { key: 'label' }, MANAGER_JOB_LABELS[task.status]),
                task.progress ? h('span', { key: 'time', className: 'dshpm-progressTime' }, `已运行 ${formatDuration(task.progress.elapsedSeconds)}`) : null,
              ]),
              task.progress
                ? h('ol', { key: 'steps', className: 'dshpm-steps', 'aria-label': '任务进度' }, task.progress.steps.map((step, index) =>
                    h('li', { key: step.key, className: `dshpm-step dshpm-step-${step.state}`, 'aria-current': step.state === 'current' ? 'step' : undefined }, [
                      h('span', { key: 'dot', className: 'dshpm-stepDot', 'aria-hidden': true }, step.state === 'done' ? '✓' : String(index + 1)),
                      h('span', { key: 'text', className: 'dshpm-stepText' }, step.label),
                    ])))
                : null,
              task.error ? h('p', { key: 'error', className: 'dshpm-stepError' }, task.error) : h('p', { key: 'note' }, '你可以离开页面，处理记录会保留。需要权限或业务决定时会等待确认。'),
              h('div', { className: 'dshpm-actions' },
                task.sessionId ? h(Button, { onClick: () => props.openSession(task.sessionId) }, '查看授权与处理详情') : null,
                task.status === 'uncertain' ? h(Button, { disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: () => mutate({ action: 'recheck' }) }, '重新检查状态') : null,
                h(Button, { disabled: busy || task.status === 'cancelling', disabledReason: busy ? '正在提交操作，请等待完成。' : '停止请求已经提交，请等待任务结束。', onClick: () => mutate({ action: 'cancel' }) }, '停止这项工作'))]) : null;
      const results = data?.contract ? h('section', { key: '成果', className: 'dshpm-results', 'aria-label': '我的成果' }, [
            h('div', { key: 'tabs', className: 'dshwb-tabGroup', role: 'group', 'aria-label': '项目内容' },
              [['documents', '我的成果'], ['decisions', '等我确认'], ['history', '项目记录']].map(([value, title]) => h('button', { key: value, type: 'button', 'aria-pressed': tab === value, onClick: () => setTab(value) }, title))),
            tab === 'history' ? h('div', { key: 'history' }, h('h2', null, '项目记录'), h('p', null, `交付目标：${data.contract.goal}`),
              h('p', { className: 'dshwb-hint' }, '需求文档提供 Word 和 Markdown；其他文档目前提供 Markdown。'),
              ...data.jobs.map(j => h('article', { key: j.id, className: 'dshpm-record' }, h('strong', null, j.kind === 'learning' ? '项目陪学' : j.kind === 'conversation' ? '管家沟通' : MANAGER_STAGE_TITLES[j.stage]),
                h('p', null, MANAGER_JOB_LABELS[j.status]), j.error ? h('p', null, j.error) : null,
                j.sessionId ? h(Button, { onClick: () => props.openSession(j.sessionId) }, '查看处理记录') : null))) : [
              h('h2', { key: 'title' }, tab === 'decisions' ? '阅读并确认具体版本' : '文档也是你的正式成果'),
              data.nextStage && data.nextStage !== selectedStage && outputs.some((o) => o.stage === data.nextStage)
                ? h('div', { key: 'pendingHint', className: 'dshpm-notice' }, [
                    h('strong', { key: 'title' }, `待你确认：${MANAGER_STAGE_TITLES[data.nextStage] || data.nextStage}`),
                    h('p', { key: 'text' }, '这一阶段的文档已经生成，核对后确认即可进入下一阶段。'),
                    h(Button, { key: 'go', kind: 'primary', onClick: () => setSelectedStage(data.nextStage) }, '去确认'),
                  ])
                : null,
              simple ? h('section',{key:'reading-hints',className:'dshpm-readingHints','aria-label':'本次成果说明'},[
                h('p',{key:'prepared'},`本类已准备 ${outputs.filter(o=>o.stage===selectedStage).length} 份文件，完整内容和下载都在下面。`),
                h('p',{key:'check'},'请重点核对目标、处理范围和完成条件；阅读提示不能替代原文。'),
                h('p',{key:'status'},missingSelected.length?`尚缺：${missingSelected.join('、')}。`:state.stageData[selectedStage]?.confirmed?'你已确认当前版本；需要调整时请提出修改。':'还需要你阅读、核对评论并明确确认当前版本。')
              ]):null,
              h('div', { key: 'stages', className: 'dshpm-actions', role: 'group', 'aria-label': '成果分类' },
                [...new Set([data.nextStage || 'spec', ...outputs.map(o => o.stage)])].map(s => h('button', { key: s, type: 'button', className: 'dshwb-chip', 'aria-pressed': selectedStage === s, onClick: () => setSelectedStage(s) }, MANAGER_STAGE_TITLES[s]))),
              h('details',{key:'advanced',className:'dshpm-advanced',open:simple?undefined:true},h('summary',null,'更多格式与模板（高级）'),h(TemplatePanel, { key: 'templates', state, stage: selectedStage, scenario: (data.contract && data.contract.scenario) || 'product', refreshKey: data.revision, showToast, download })),
              h('div', { key: 'files', className: 'dshpm-files' }, outputs.filter(o => o.stage === selectedStage).map(o => h('article', { key: o.name }, h('strong', null, o.name),
                h('span', null, o.confirmed ? '已确认版本' : '待审阅'), h(Button, { onClick: () => download(o.name, o.name) }, `下载${o.name.endsWith('.docx') ? ' Word' : ''}`)))),
              hasDocument ? h('div', { key: `document-${identity}-${selectedStage}`, className: 'dshwb-documentWorkspace dshpm-document' },
                h(DocumentPane, { state, copy, managerMode: true, stage: selectedStage, localeId: 'zh', docsVersion: data.revision, showToast,
                  onRefresh: () => setRetry(n => n + 1), onGenerateDocx: () => showToast('需求 Word 会在管家任务完成后从正式原稿生成。'),
                  onRequestChanges: text => { setDraft(text);if(simple){setSimpleResultsOpen(false);setFocusComposer(v=>v+1);}showToast('修改意见已放入输入框，确认后告诉管家。'); } })) : h('p', { key: 'empty', className: 'dshpm-empty' }, '正式文档准备好后会出现在这里。你可以先和管家聊聊想法。'),
              data.nextStage === selectedStage && hasDocument ? h('div', { key: 'approval', className: 'dshpm-approval' }, [
                h('h3', { key: 'title' }, '确认当前文档版本'),
                h('p', { key: 'hint', className: 'dshwb-hint' }, '请核对本类全部文档。确认会保存版本快照；以后修改将重新审阅。'),
                selectedStage === 'build' ? data.buildChecks.map(c => h('label', { key: c.id }, h('input', { type: 'checkbox', checked: checks.includes(c.id), onChange: e => setChecks(v => e.target.checked ? [...v, c.id] : v.filter(x => x !== c.id)) }), c.text)) : null,
                h('label', { key: 'read' }, h('input', { type: 'checkbox', checked: reviewed, onChange: e => setReviewed(e.target.checked) }), '我已阅读本类文档，并确认当前内容符合需要'),
                h(Button, { key: 'confirm', kind: 'primary', disabled: Boolean(approvalReason), disabledReason:approvalReason, onClick: () => mutate({ action: 'approve', stage: selectedStage, reviewed: true, checks, hashes: selectedHashes }) }, '确认这一版'),
              ]) : null,
              hasDocument ? h('details', { key: 'revise', className: 'dshpm-revise' }, h('summary', null, '这份成果需要修改'),
                h('p', { className: 'dshwb-hint' }, '重新开启后，这份成果及受影响的后续文档需要重新确认，历史版本保留。'),
                h('textarea', { className: 'dshwb-input', rows: 2, value: revisionText, onChange: e => setRevisionText(e.target.value), 'aria-label': '成果修改要求', maxLength: 6000 }),
                h(Button, { disabled: locked || !revisionText.trim(), disabledReason:locked ? lockedReason : '请先填写具体的成果修改要求。', onClick: async () => { if (await mutate({ action: 'revise', stage: selectedStage, text: revisionText })) setRevisionText(''); } }, '提交修改安排')) : null,
              data.complete ? h('div', { key: 'delivery', className: 'dshpm-proposal' }, h('h3', null, '正式文档交付'),
                h('p', null, '下载包包含已确认的正式文档和版本清单。代码和运行环境不包含在文档包中。'),
                h(Button, { disabled: locked, disabledReason:lockedReason, onClick: () => mutate({ action: 'package' }) }, data.delivery ? '重新整理文档包' : '整理交付文档包'),
                data.delivery ? h(Button, { kind: 'primary', onClick: () => download(data.delivery.path, '项目交付文档.zip') }, '下载交付文档包') : null) : null,
            ],
          ]):null;
      return h('div', { className: 'dshpm-page'+(simple?' dshpm-simple':''), 'data-testid': 'personal-manager-page' }, [
        h('style', { key: 'style' }, CSS + MANAGER_CSS + '.dshpm-learning{max-width:900px;margin:0 auto;width:100%;box-sizing:border-box}.dshpm-sourcePicker{max-height:260px;overflow:auto;padding:12px;border:1px solid var(--border-color,#7774);border-radius:10px}.dshpm-sourcePicker label{display:flex;align-items:flex-start;gap:8px;padding:6px 0;overflow-wrap:anywhere}.dshpm-sourcePicker input{flex-shrink:0}.dshpm-learningEvidence{margin:0 12px 18px;font-size:13px;overflow-wrap:anywhere}.dshpm-learning .dshpm-messages{min-height:180px;max-height:55vh}.dshpm-learningSources{padding:12px 0}'),
        h(Toast, { key: 'toast', toast }),
        h('header', { key: 'header', className: 'dshpm-header' }, [
          h('div', { key: 'title' }, h('p', { className: 'dshpm-eyebrow' }, '你的项目管家'), h('h1', null, state.project.name || (simple?'项目管家':'一起把想法做出来')),
            h('p', { className: 'dshwb-hint' }, data?.complete ? '本次约定的成果已确认，可以下载文档包。' : task ? MANAGER_JOB_LABELS[task.status] : data?.contract ? `本轮：${MANAGER_STAGE_TITLES[stage] || '了解你的想法'}${simple?' · '+data.presentation.title:''}` : '和一个管家沟通，完整文档随时保留。')),
          h('div', { key: 'actions', className: 'dshpm-actions' },[
            h('div',{key:'mode',className:'dshwb-tabGroup','aria-label':'管家显示模式',role:'group'},[['simple','简洁模式'],['full','完整管家']].map(([value,label])=>h('button',{key:value,type:'button','aria-pressed':managerMode===value,onClick:()=>changeManagerMode(value)},label))),
            simple && data?.contract?h(Button,{key:'results',onClick:()=>{setTab('documents');setSimpleResultsOpen(true);}},`我的成果 · ${data.outputs.length}`):null,
            h(Button,{key:'learning',disabled:!data,disabledReason:'正在加载项目，请稍等。',onClick:()=>setLearningOpen(v=>!v)},learningOpen?'返回项目工作':'带我学懂这个项目'),
            h(Button,{key:'help',onClick:()=>window.open('/workbench/guide','_blank','noopener')},'使用手册'),
            h('details',{key:'more',className:'dshpm-more'},h('summary',null,'更多'),
              h(Button, { disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: selectProject }, '选择项目文件夹'),
              h(Button, { disabled: busy, disabledReason: '正在处理当前操作，请等待完成后再试。', onClick: newProject }, '新建项目'),
              simple && data?.contract?h(Button,{onClick:()=>{setTab('history');setSimpleResultsOpen(true);}},'项目记录'):null,
              h(Button, { onClick: props.onDetails }, '详细工作区'))]),
        ]),
        (error || meta.phase === 'offline') ? h('div', { key: 'error', role: 'alert', className: 'dshpm-notice' },
          h('p', null, error || meta.error || '暂时无法连接工作台，输入内容会保留。'), h(Button, { onClick: () => { setRetry(n => n + 1); store.hydrate(true); } }, '重新连接')) : null,
        !data && !error ? h('p', { key: 'loading', role: 'status' }, '正在找回你的项目…') : null,
        managerMode==='simple' && data && !supportsManagerPresentation(data.presentation)?h('p',{key:'protocol',role:'status'},'当前服务尚不支持简洁模式，暂时展示完整管家。'):null,
        learningOpen && data ? h(ManagerLearning,{key:identity+'-learning',storageKey:'dshwb-learning:'+identity,data,locked,reason:managerReason,mutate,showToast,openSession:props.openSession}) : data && !data.contract ? h(ManagerSetup,{key:identity,name,goal,scenario,setName,setGoal,setScenario,busy,onConfigure:configure}) : data ? h('div', { key: 'layout', className: 'dshpm-layout' }, [
          h('section', { key: 'chat', className: 'dshpm-conversation', 'aria-label': '和管家说' }, [
            !simple?h('h2', { key: 'title' }, '和管家说'):null,
            !data.available ? h('p', { key: 'unavailable', role: 'alert' }, '管家执行服务尚未连接，请重启 DSH Host。') : null,
            simple?h(ManagerThread,{key:'messages',messages:data.messages,presentation:data.presentation,busy,locked:locked || !data.available,lockedReason:managerReason,onAction:runManagerAction,onAnswer:(questionId,text)=>mutate({action:'answer',questionId,text}),onDocument:stage=>{setSelectedStage(stage);setTab('documents');setSimpleResultsOpen(true);},progress}):h('div', { key: 'messages', className: 'dshpm-messages', ref: messagesRef, onScroll: e => { const el = e.currentTarget; followMessagesRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }, role: 'log', 'aria-label': '管家对话记录' }, data.messages.map(m =>
              h(ManagerMessage, { key:m.id, message:m, hideQuestions:simple, locked:locked || !data.available, lockedReason:managerReason, onAnswer:(questionId,text)=>mutate({action:'answer',questionId,text}), onDocument:stage=>setSelectedStage(stage) }))),
            !simple?progress:null,
            !simple && data.proposal ? (() => {
              const lines = proposalLines(data.proposal.instruction);
              return h('article', { key: 'proposal', className: 'dshpm-proposal' }, [
                h('div', { key: 'head', className: 'dshpm-proposalHead' }, [
                  h('h3', { key: 'title' }, '建议的下一步'),
                  h('span', { key: 'stage', className: 'dshpm-proposalStage' },
                    `${MANAGER_STAGE_TITLES[data.proposal.stage] || data.proposal.stage}${data.proposal.extend ? ' · 扩展交付目标' : ' · 当前阶段'}`),
                ]),
                lines.length > 0
                  ? h('ul', { key: 'lines', className: 'dshpm-proposalList' },
                      lines.map((line, index) => h('li', { key: index }, inlineBold(line))))
                  : h('p', { key: 'text', className: 'dshpm-messageText' }, inlineBold(data.proposal.instruction)),
                h('div', { key: 'actions', className: 'dshpm-actions' },
                  h(Button, {
                    kind: 'primary',
                    disabled: locked || !data.available, disabledReason:managerReason,
                    onClick: () => mutate({ action: 'dispatch', proposalId: data.proposal.id }),
                  }, data.proposal.extend ? '扩展交付目标并开始' : '按这个安排开始')),
              ]);
            })() : null,
            simple?h('div',{key:'chat-starters',className:'dshpm-starters','aria-label':'对话提示'},[['请解释一下','我不太明白，请用具体例子解释一下。'],['补充一个要求','我想补充一个要求：'],['告诉我做到哪了','请用简单的话告诉我目前做到哪里，还需要我决定什么。']].map(([label,text])=>h(Button,{key:label,disabled:locked || !data.available,disabledReason:managerReason,onClick:()=>{setDraft(text);setFocusComposer(v=>v+1);}},label))):null,
            h('form', { key: 'composer', className: 'dshpm-composer', onSubmit: e => { e.preventDefault(); message(draft); } },
              h('label', null, '想补充什么，或有什么不明白？', h('textarea', { className: 'dshwb-input', ref:composerRef, rows: simple?2:3, value: draft, maxLength: 8000, onChange: e => setDraft(e.target.value), placeholder: '直接告诉我，也可以说“我不明白，举个例子”。' })),
              h('div', { className: 'dshpm-actions' },
                simple && stopAction?h(Button,{disabled:busy || stopAction.enabled===false,disabledReason:busy?'正在提交操作，请等待完成。':stopAction.reason,onClick:()=>runManagerAction(stopAction,data.revision)},task?.status==='cancelling'?'正在停止…':'停止这项工作'):null,
                h(Button, { type: 'submit', kind: 'primary', disabled: locked || !data.available || !draft.trim(), disabledReason:locked || !data.available ? managerReason : '请先填写想告诉管家的内容。' }, '告诉管家'),
                !simple ? h(Button, { disabled: locked || !data.available, disabledReason:managerReason, onClick: () => message('请根据本次交付目标，帮我整理第一版安排；信息不足时先问我。') }, '帮我整理第一版'):null)),
          ]),
          h(ManagerResultsSheet,{key:'result-sheet',simple,open:simpleResultsOpen,onClose:()=>setSimpleResultsOpen(false)},results),
        ]) : null,
      ]);
    }

    function DetailedWorkbenchPage(props) {
      const { state, meta, store } = useWorkbench();
      const localeId = useLocaleId(props.localeRuntime);
      const copy = copyFor(localeId);
      const [busy, setBusy] = React.useState('');
      const [docsVersion, setDocsVersion] = React.useState(0);
      const review = useArtifactReview(state.boardId, meta.projectRoot, docsVersion);
      const [dockTab, setDockTab] = React.useState('docs');
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [preferredDocument, setPreferredDocument] = React.useState('');
      const [toast, showToast] = useToast();
      const [layout, setLayout] = React.useState(readLayoutPreference);
      const [dragging, setDragging] = React.useState(null);
      const surfaceRef = React.useRef(null);
      const stopDragRef = React.useRef(null);

      React.useEffect(() => {
        writeLayoutPreference(layout);
      }, [layout]);

      React.useEffect(
        () => () => {
          if (stopDragRef.current) stopDragRef.current();
        },
        [],
      );

      /** Commit one column width; the CSS variables and storage follow. */
      const commitLayout = (side, width) => {
        const next = Math.round(width);
        setLayout((current) => (current[side] === next ? current : { ...current, [side]: next }));
      };

      /** @returns the width the dragging column may not exceed in this viewport. */
      const ceilingOf = (side) => {
        const limits = LAYOUT_LIMITS[side];
        const surface = surfaceRef.current;
        const node = surface
          ? surface.querySelector(side === 'rail' ? '.dshwb-shell' : '.dshwb-main')
          : null;
        const extent = node && node.clientWidth > 0 ? node.clientWidth : 0;
        if (extent === 0) return limits.max;
        const reserved = side === 'rail' ? 560 : 520;
        return Math.max(limits.min, Math.min(limits.max, extent - reserved));
      };

      /** @returns whether a column handle is hidden by the responsive layout. */
      const hiddenSide = (side) => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return window.matchMedia(side === 'rail' ? '(max-width: 980px)' : '(max-width: 1099px)').matches;
      };

      /** Clamp px beyond the current viewport back into range. */
      React.useEffect(() => {
        setLayout((current) => {
          const rail = hiddenSide('rail') ? current.rail : Math.min(current.rail, ceilingOf('rail'));
          const dock = hiddenSide('dock') ? current.dock : Math.min(current.dock, ceilingOf('dock'));
          return rail === current.rail && dock === current.dock ? current : { ...current, rail, dock };
        });
        // The measurement only needs the first laid-out frame.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      /**
       * Start dragging one boundary. The width is written straight to the
       * surface's CSS variables while the pointer moves, so the page does not
       * re-render mid-gesture; only the final width reaches React state.
       */
      const beginResize = (side) => (event) => {
        if (event.button !== 0) return;
        const surface = surfaceRef.current;
        if (!surface) return;
        const limits = LAYOUT_LIMITS[side];
        const ceiling = ceilingOf(side);
        const startX = event.clientX;
        const startValue = layout[side];
        const variable = side === 'rail' ? '--dshwb-rail-width' : '--dshwb-dock-width';
        let next = startValue;
        let finished = false;
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          const raw = side === 'rail' ? startValue + delta : startValue - delta;
          next = Math.round(Math.min(ceiling, Math.max(limits.min, raw)));
          surface.style.setProperty(variable, `${next}px`);
        };
        const end = (commit) => {
          if (finished) return;
          finished = true;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          document.body.style.removeProperty('user-select');
          document.body.style.removeProperty('cursor');
          stopDragRef.current = null;
          setDragging(null);
          if (commit) commitLayout(side, next);
          else surface.style.setProperty(variable, `${startValue}px`);
        };
        function onUp() {
          end(true);
        }
        function onCancel() {
          end(false);
        }
        stopDragRef.current = () => end(false);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        setDragging(side);
      };

      /** Keyboard nudging: arrow keys move the boundary by 16px. */
      const nudge = (side) => (delta) => {
        const limits = LAYOUT_LIMITS[side];
        const raw = side === 'rail' ? layout[side] + delta : layout[side] - delta;
        commitLayout(side, Math.min(ceilingOf(side), Math.max(limits.min, raw)));
      };

      const resetSide = (side) => () => commitLayout(side, LAYOUT_DEFAULT[side]);

      const stage = STAGES.includes(state.stage) ? state.stage : STAGES[0];
      // Requirements analysis runs in its own Session/agent; the dock follows
      // whichever Session owns the stage being worked on.
      const currentSessionId = sessionFor(state, stage);
      const { reference, failed: sessionFailed } = useSessionReference(currentSessionId, props.retainSession);
      const liveSession = useSessionSnapshot(reference);
      const fallbackRunning = useRunning(props.useSessionStatus, currentSessionId);
      const running = liveSession ? liveSession.running === true : fallbackRunning;
      const suggestedRoot = useSuggestedRoot(props.useSessions);
      const archive = useRequirementIndex();
      const roster = useBoardRoster(`${meta.projectRoot}:${state.boardId}:${state.stateRevision}:${docsVersion}`);
      const [autoNext, setAutoNext] = React.useState(false);
      const [panel, setPanel] = React.useState('board');
      const [removingRecords, setRemovingRecords] = React.useState(false);
      const removingRecordsRef = React.useRef(false);
      const [deleteRequest, setDeleteRequest] = React.useState(null);
      const deleteRequestRef = React.useRef(null);
      const confirmedCount = STAGES.filter((key) => state.stageData[key].confirmed).length;

      // The moment the agent finishes a turn is when its deliverables become
      // real: refresh the document list then, so the pane matches the session.
      const wasRunning = React.useRef(false);
      React.useEffect(() => {
        if (wasRunning.current && !running) setDocsVersion((value) => value + 1);
        wasRunning.current = running;
      }, [running]);

      React.useEffect(() => {
        setDockTab('docs');
      }, [stage]);

      // Restore the most recently touched requirement when the browser has no
      // project directory yet; fall back to the latest session directory.
      const archiveReady = archive.phase === 'ready' || archive.phase === 'error';
      React.useEffect(() => {
        if (!archiveReady || store.isRootChosen()) return;
        const latest = archive.items[0];
        if (latest && latest.root && latest.exists !== false) store.setRoot(latest.root);
        else if (suggestedRoot) store.setRoot(suggestedRoot);
      }, [archiveReady, archive.items.length, suggestedRoot, store]);

      const notifyIfLocked = (target) => {
        if (!isLocked(state, target)) return false;
        const index = STAGES.indexOf(target);
        showToast(
          localeId === 'zh'
            ? `请先确认「${copy.stage[STAGES[index - 1]].title}」`
            : `Confirm “${copy.stage[STAGES[index - 1]].title}” first.`,
          'error',
        );
        return true;
      };

      const start = async (target) => {
        if (notifyIfLocked(target)) return;
        if (busy !== '') return;
        setBusy(`start:${target}`);
        try {
          store.invalidateFrom(target);
          const prompt = buildStagePrompt(state, target, {

            queue: { waiting: personaWaiting(roster, STAGES.indexOf(target), str(state.boardId)) },
          });
          await sendContextPrompt(props.sendPrompt, prompt, { stage: target });
          store.patchStage(target, { startedAt: new Date().toISOString() });
          store.addActivity(`${copy.stage[target].title} · ${copy.action.start}`, 'prompt');
          setDocsVersion((value) => value + 1);
          // Keep the current document visible beside the conversation.
          showToast(copy.toast.sent, 'success');
        } catch (error) {
          showToast(String(error.message || error), 'error');
        } finally {
          setBusy('');
        }
      };

      const confirm = async (target, note) => {
        if (busy !== '') return;
        // Closing the delivery needs 交付清单.md. If the stage was never started,
        // do not dead-end the person on a missing document: start the agent on it
        // first, then let them confirm once it exists.
        if (target === 'ship' && !state.stageData.ship.startedAt) {
          const pending = await missingDocuments(state, 'ship');
          if (pending.length > 0) {
            showToast(copy.toast.needDocShipStarting, 'info');
            await start('ship');
            return false;
          }
        }
        setBusy(`confirm:${target}`);
        try {
          if (target === 'spec') {
            const ok = await ensureRequirementDocx();
            if (ok === 'generated') {
              showToast(localeId === 'en' ? 'Word document generated. Review it, then confirm again.' : 'Word 交付稿已生成，请核对后再次确认。', 'info');
              return false;
            }
            if (!ok) {
              showToast(copy.toast.needDoc(copy.stage.spec.output), 'error');
              return false;
            }
          } else {
            const missing = await missingDocuments(state, target);
            if (missing.length > 0) {
              showToast(
                target === 'ship' ? copy.toast.needDocShip(missing[0]) : copy.toast.needDoc(missing[0]),
                'error',
              );
              return false;
            }
          }
          const reviewed = review.data;
          if (!reviewed || reviewed.boardId !== state.boardId) throw new Error('请等待本轮版本信息加载后确认');
          await store.flush();
          const response = await apiFetch(ARTIFACTS_URL, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'confirm', stage: target,
              hashes: reviewed.stages[target].hashes, note: note || '' }),
          });
          const payload = await readApiJson(response);
          if (!response.ok) throw new Error(payload.message || '确认失败');
          store.adopt(payload.state);
          setSettingsOpen(false);
          store.addActivity(`${copy.stage[target].title} · ${copy.status.confirmed}`, 'confirm');
          const index = STAGES.indexOf(target);
          if (index < STAGES.length - 1) store.setStage(STAGES[index + 1]);
          setDocsVersion((value) => value + 1);
          showToast(copy.toast.confirmed(copy.stage[target].title), 'success');
          if (autoNext) advancePersona(target);
          return true;
        } catch (error) {
          showToast(String(error.message || error), 'error');
          return false;
        } finally {
          setDocsVersion((value) => value + 1);
          setBusy('');
        }
      };

      const modify = async (text, steer) => {
        if (busy !== '') return false;
        setBusy('modify');
        try {
          store.invalidateFrom(stage);
          const prompt = buildModifyPrompt(state, stage, text);
          await sendContextPrompt(props.sendPrompt, prompt, { stage, mode: steer ? 'steer' : 'queue' });
          store.addActivity(`${copy.modify.title}: ${text.slice(0, 120)}`, 'prompt');
          // Keep the current document visible beside the conversation.
          showToast(copy.toast.modified, 'success');
          return true;
        } catch (error) {
          showToast(String(error.message || error), 'error');
          return false;
        } finally {
          setBusy('');
        }
      };

      const fix = async () => {
        if (busy !== '') return;
        setBusy('fix');
        try {
          await sendContextPrompt(props.sendPrompt, buildFixPrompt(state), { stage: 'verify' });
          store.patchStage('verify', { fixRounds: (state.stageData.verify.fixRounds || 0) + 1 });
          store.addActivity(`${copy.verify.fix} #${(state.stageData.verify.fixRounds || 0) + 1}`, 'prompt');
          // Keep the current document visible beside the conversation.
          showToast(copy.toast.sent, 'success');
        } catch (error) {
          showToast(String(error.message || error), 'error');
        } finally {
          setBusy('');
        }
      };

      const deploy = async () => {
        if (busy !== '') return;
        setBusy('deploy');
        try {
          await sendContextPrompt(props.sendPrompt, buildDeployPrompt(state), { stage: 'ship' });
          store.patchStage('ship', {
            deployRequested: true,
            deployStartedAt: new Date().toISOString(),
          });
          store.addActivity(copy.ship.deploy, 'deploy');
          // Keep the current document visible beside the conversation.
          showToast(copy.toast.deployed, 'success');
        } catch (error) {
          showToast(String(error.message || error), 'error');
        } finally {
          setBusy('');
        }
      };

      const generateDocx = async () => {
        if (busy !== '') return;
        setBusy('docx');
        try {
          const response = await apiFetch(DOCX_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: '需求分析阶段.md', target: '需求分析阶段.docx' }),
          });
          const payload = await readApiJson(response).catch(() => ({}));
          if (!response.ok) throw new Error(payload.message || copy.toast.docxFailed);
          setDocsVersion((value) => value + 1);
          showToast(copy.docs.generated, 'success');
        } catch (error) {
          showToast(String(error.message || copy.toast.docxFailed), 'error');
        } finally {
          setBusy('');
        }
      };

      const reset = async () => {
        if (typeof window !== 'undefined' && !window.confirm(copy.resetConfirm)) return;
        if (busy) return;
        setBusy('reset');
        try {
          await store.flush();
          const response = await apiFetch(BOARDS_URL, { method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'create', flow: 'new' }) });
          const payload = await readApiJson(response);
          if (!response.ok) throw new Error(payload.message || '创建失败');
          store.adopt({ ...payload.state, boardId: payload.boardId });
          setDocsVersion((value) => value + 1);
          showToast(localeId === 'en' ? 'New board created; previous history kept.' : '已新建看板，原看板与版本历史已保留。', 'success');
        } catch (error) { showToast(String(error.message || error), 'error'); }
        finally { setBusy(''); }
      };

      const openSession = () => {
        if (!currentSessionId) {
          showToast(copy.toast.noSession, 'info');
          return;
        }
        props.openSession(currentSessionId);
      };

      const startNewRound = async () => {
        if (typeof window !== 'undefined' && !window.confirm(copy.flow.newRoundConfirm)) return;
        if (busy !== '') return;
        setBusy('round');
        try {
          await store.flush();
          const response = await apiFetch(ROUNDS_URL, { method: 'POST' });
          const payload = await readApiJson(response).catch(() => ({}));
          if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
          store.adopt(payload.state);
          setDocsVersion((value) => value + 1);
          setDockTab('docs');
          archive.refresh();
          showToast(copy.flow.newRoundDone(payload.archived || ''), 'success');
        } catch (error) {
          showToast(String(error.message || error), 'error');
        } finally {
          setBusy('');
        }
      };

      /** Activate one board and reload the workbench state from it. */
      const activateBoard = async (id) => {
        await store.flush();
        const response = await apiFetch(BOARDS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'activate', id }),
        });
        if (!response.ok) throw new Error('Cannot activate board');
        await store.hydrate(true);
      };

      /**
       * Open one persona: switch to the board it holds now, focus its stage and
       * put the cursor in that conversation. `start` also sends the kickoff
       * prompt when the task has not begun.
       */
      const openPersonaTask = async (personaStage, options = {}) => {
        const index = STAGES.indexOf(personaStage);
        const board = options.boardId ? roster.boards.find(item => item.id === options.boardId) : personaCurrent(roster, index);
        if (!board) {
          showToast(copy.team.noTask, 'info');
          return;
        }
        if (options.start && board.confirmed !== index) { showToast(localeId === 'en' ? 'Confirm upstream stages first.' : '请先确认前序阶段，不能跳过阶段启动任务。', 'error'); return; }
        if (busy !== '') return;
        setBusy('persona');
        try {
          const activeId = str(workbenchStore.get().boardId) || roster.activeId;
          if (board.id !== activeId) {
            await activateBoard(board.id);
          }
          store.setStage(personaStage);
          setPanel('board');
          // Conversation stays visible for every workspace mode.
          if (options.start && !board.stageStarted) {
            const prompt = buildStagePrompt(workbenchStore.get(), personaStage, {

              queue: { waiting: personaWaiting(roster, index, board.id) },
            });
            await sendContextPrompt(props.sendPrompt, prompt, { stage: personaStage });
            store.patchStage(personaStage, { startedAt: new Date().toISOString() });
          }
          roster.refresh();
        } catch (error) {
          showToast(String(error.message || error), 'error');
        } finally {
          setBusy('');
        }
      };

      /**
       * After a confirmation, the same persona picks up the next requirement in
       * its queue (oldest first) and starts it, unless the queue is empty.
       */
      const advancePersona = async (personaStage) => {
        try {
          const index = STAGES.indexOf(personaStage);
          const current = str(workbenchStore.get().boardId) || roster.activeId;
          const snapshot = await fetchBoardRoster();
          const next = (snapshot.boards || [])
            .filter((board) => board.confirmed === index && board.id !== current)
            .sort((left, right) => (left.round || 1) - (right.round || 1))[0];
          roster.refresh();
          if (!next) return;
          await activateBoard(next.id);
          store.setStage(personaStage);
          const prompt = buildStagePrompt(workbenchStore.get(), personaStage, {

            queue: { waiting: personaWaiting({ boards: snapshot.boards }, index, next.id) },
          });
          await sendContextPrompt(props.sendPrompt, prompt, { stage: personaStage });
          store.patchStage(personaStage, { startedAt: new Date().toISOString() });
          roster.refresh();
          showToast(copy.team.nextStarted(next.name || next.id), 'info');
        } catch (error) {
          console.warn('workbench: queue advance failed:', error);
        }
      };

      const openRequirement = async (item) => {
        setBusy('archive-open');
        try {
          await store.flush();
          if (item.boardId) {
            await apiFetch(BOARDS_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'activate', id: item.boardId, root: item.root }),
            });
          }
          await store.setRoot(item.root);
          setPanel('board');
          showToast(copy.requirements.opened(item.name || item.title || item.root), 'success');
        } catch (error) {
          showToast(String(error.message || error), 'error');
        } finally {
          setBusy('');
        }
      };

      const openRequirementSession = (item) => {
        const sessions = item.stageSessions && typeof item.stageSessions === 'object' ? item.stageSessions : {};
        const id = sessions[item.stage] || (item.stage === 'spec' ? item.specSessionId : item.sessionId);
        if (!id) return;
        props.openSession(id);
      };

      const finishDeleteRequest = (result) => {
        const request = deleteRequestRef.current;
        deleteRequestRef.current = null; setDeleteRequest(null);
        request?.resolve(result);
      };
      const requestRemoveRequirements = (items) => new Promise(resolve => {
        if (!items.length || removingRecordsRef.current || deleteRequestRef.current) { resolve(false); return; }
        const request = { items: [...items], resolve };
        deleteRequestRef.current = request; setDeleteRequest(request);
      });
      const confirmRemoveRequirements = async () => {
        const request = deleteRequestRef.current;
        if (!request || removingRecordsRef.current) return;
        removingRecordsRef.current = true; setRemovingRecords(true);
        try {
          const result = await removeRequirementRecords(request.items);
          archive.refresh();
          showToast(localeId === 'en' ? `${result.removed} record(s) removed.` : `已删除 ${result.removed} 条需求档案记录。`, 'success');
          finishDeleteRequest(true);
        } catch (error) {
          showToast(String(error.message || error), 'error');
          finishDeleteRequest(false);
        } finally { removingRecordsRef.current = false; setRemovingRecords(false); }
      };
      const removeRequirement = item => requestRemoveRequirements([item]);

      const stageBody = (() => {
        const common = {
          key: 'stage-body',
          state,
          copy,
          store,
          busy,
          onStart: start,
          onOpenSession: openSession,
          onConfirm: confirm,
          showToast,
        };
        if (stage === 'spec') return h(SpecStage, common);
        if (stage === 'design') return h(DesignStage, common);
        if (stage === 'build') return h(BuildStage, { ...common, onOpenPreview: () => setDockTab('preview') });
        if (stage === 'verify') return h(VerifyStage, { ...common, onFix: fix });
        return h(ShipStage, { ...common, onDeploy: deploy });
      })();

      const saveLabel =
        meta.save === 'saving' ? copy.saving : meta.save === 'local' ? copy.localOnly : copy.saved;

      return h(
        'div',
        {
          className: 'dshwb-surface dshwb-page',
          'data-testid': 'workbench-page',
          ref: surfaceRef,
          style: {
            '--dshwb-rail-width': `${layout.rail}px`,
            '--dshwb-dock-width': `${layout.dock}px`,
          },
        },
        [
          h('style', { key: 'css' }, CSS),
          h(Toast, { key: 'toast', toast }),
          h(WorkspaceDrawer, { key: 'delete-confirmation', open: !!deleteRequest, busy: removingRecords,
            title: localeId === 'en' ? 'Confirm requirement record deletion' : '确认删除需求记录',
            onClose: () => { if (!removingRecordsRef.current) finishDeleteRequest(false); } }, [
            h('p', { key: 'scope' }, localeId === 'en'
              ? `Remove these ${deleteRequest?.items.length || 0} records from the archive? Project code, documents and sessions stay untouched.`
              : `确定从需求档案删除以下 ${deleteRequest?.items.length || 0} 条记录？项目代码、文档和会话均保留。`),
            h('ul', { key: 'items', className: 'dshwb-reqDeleteList' }, (deleteRequest?.items || []).map(item =>
              h('li', { key: requirementKey(item) }, h('strong', null, item.name || item.title || item.root), h('code', null, item.root)))),
            h('div', { key: 'actions', className: 'dshwb-personaActions' }, [
              h(Button, { key: 'cancel', disabled: removingRecords, disabledReason: '正在删除需求记录，请等待删除完成。', onClick: () => finishDeleteRequest(false) }, localeId === 'en' ? 'Cancel' : '取消'),
              h(Button, { key: 'confirm', kind: 'primary', disabled: removingRecords, disabledReason: '正在删除需求记录，请等待删除完成。', onClick: confirmRemoveRequirements }, removingRecords
                ? (localeId === 'en' ? 'Removing…' : '正在删除…')
                : (localeId === 'en' ? `Confirm deletion of ${deleteRequest?.items.length || 0} records` : `确认删除 ${deleteRequest?.items.length || 0} 条记录`)),
            ]),
          ]),
          dragging ? h('div', { key: 'dragShield', className: 'dshwb-dragShield' }) : null,
          h(
            'header',
            { key: 'head', className: 'dshwb-topbar' },
            h(
              'div',
              { key: 'brand', className: 'dshwb-brand' },
              h('span', { key: 'mark', className: 'dshwb-brandMark' }, h(Icon, { name: 'spark', size: 18 })),
              h('div', { key: 'text', className: 'dshwb-brandText' }, [
                h('h1', { key: 'title' }, copy.appTitle),
                h('p', { key: 'sub' }, copy.appSub),
              ]),
            ),
            h(
              'div',
              { key: 'meta', className: 'dshwb-topbarMeta' },
              props.onManager ? h(Button, { onClick: props.onManager }, '返回项目管家') : null,
              h(
                'div',
                { key: 'project', className: 'dshwb-topProject' },
                h('span', { className: 'dshwb-topProjectLabel' }, copy.project),
                h('strong', null, projectLabel(state, meta, copy)),
              ),
              h(
                'span',
                {
                  key: 'save',
                  className: `dshwb-saveState dshwb-saveState-${meta.save}`,
                  title: meta.error || '',
                },
                h('span', { className: 'dshwb-saveDot', 'aria-hidden': true }),
                saveLabel,
              ),
              h(
                'div',
                { key: 'progress', className: 'dshwb-topProgress' },
                h('span', null, `${copy.progress} ${confirmedCount}/${STAGES.length}`),
                h(
                  'span',
                  { className: 'dshwb-progressTrack dshwb-progressTrackTop' },
                  h('span', { style: { width: `${(confirmedCount / STAGES.length) * 100}%` } }),
                ),
              ),
              h(
                Button,
                {
                  kind: 'ghost',
                  size: 'xs',
                  onClick: () => {
                    archive.refresh();
                    setPanel(panel === 'requirements' ? 'board' : 'requirements');
                  },
                  title: copy.requirements.title,
                },
                h(Icon, { name: 'doc', size: 13 }),
                copy.requirements.openBoard,
              ),
              h(
                Button,
                {
                  kind: 'ghost',
                  size: 'xs',
                  onClick: () => {
                    roster.refresh();
                    setPanel(panel === 'team' ? 'board' : 'team');
                  },
                  title: copy.team.title,
                },
                h(Icon, { name: 'users', size: 13 }),
                copy.team.open,
              ),
              h(
                Button,
                { kind: 'ghost', size: 'xs', onClick: reset, title: copy.reset },
                copy.reset,
              ),
            ),
          ),
          h(
            'div',
            { key: 'shell', className: 'dshwb-shell' },
            h(
              'div',
              { key: 'left', className: 'dshwb-left' },
              h(StageRail, {
                key: 'rail',
                state,
                copy,
                onSelect: (target) => {
                  store.setStage(target);
                  setDocsVersion((value) => value + 1);
                },
              }),
              h(ActivityRail, { key: 'activity', state, copy }),
            ),
            h(SplitHandle, {
              key: 'split-rail',
              side: 'rail',
              value: layout.rail,
              limits: LAYOUT_LIMITS.rail,
              dragging: dragging === 'rail',
              label: copy.layout.railHandle,
              onDragStart: beginResize('rail'),
              onNudge: nudge('rail'),
              onReset: resetSide('rail'),
            }),
            h(
              'main',
              { key: 'main', className: 'dshwb-main' },
              h(
                'div',
                { key: 'content', className: 'dshwb-content' },
                h(TaskGuide, { key: 'guide', state, stage, running, busy, copy, localeId,
                  onSelect: target => { store.setStage(target); setPanel('board'); },
                  onStart: target => { store.setStage(target); setPanel('board'); start(target); },
                  onReview: target => { store.setStage(target); setPanel('board'); setSettingsOpen(true); },
                  onQueue: () => { roster.refresh(); setPanel('team'); } }),
                panel === 'team'
                  ? h(TeamPanel, {
                      copy,
                      roster,
                      autoNext,
                      onToggleAutoNext: setAutoNext,
                      activeBoardId: str(state.boardId),
                      localeId,
                      onOpenSession: props.openSession,
                      onTalk: (personaStage, boardId) => openPersonaTask(personaStage, { boardId }),
                      onStart: (personaStage, boardId) => openPersonaTask(personaStage, { start: true, boardId }),
                      onOpenBoard: (personaStage, boardId) => openPersonaTask(personaStage, { chat: false, boardId }),
                    })
                  : panel === 'requirements'
                  ? h(RequirementLibrary, {
                      key: 'archive',
                      copy,
                      localeId,
                      archive,
                      onOpen: openRequirement,
                      onOpenSession: openRequirementSession,
                      onRemove: removeRequirement,
                      onRemoveMany: requestRemoveRequirements,
                      removing: removingRecords,
                      onBack: () => setPanel('board'),
                      onRefresh: archive.refresh,
                    })
                  : [
                      h('div', { key: 'heading', className: 'dshwb-stageHead' }, [
                        h('div', { key: 'eyebrow', className: 'dshwb-eyebrow' }, copy.stageOf(STAGES.indexOf(stage) + 1, STAGES.length)),
                        h('div', { key: 'title', className: 'dshwb-stageTitleRow' },
                          h('h2', { className: 'dshwb-stageTitle' }, copy.stage[stage].title),
                          h(StatusPill, { status: running ? 'running' : stageStatus(state, stage), copy })),
                        h('p', { key: 'desc', className: 'dshwb-stageDesc' }, copy.stage[stage].desc),
                      ]),
                      h('div', { key: 'tools', className: 'dshwb-workspaceToolbar' }, [
                        h('div', { key: 'modes', className: 'dshwb-tabGroup', role: 'group', 'aria-label': localeId === 'en' ? 'Workspace mode' : '工作区模式' },
                          h('button', { type: 'button', 'aria-pressed': dockTab === 'docs', onClick: () => setDockTab('docs') }, localeId === 'en' ? 'Document review' : '文档审阅'),
                          h('button', { type: 'button', 'aria-pressed': dockTab === 'preview', onClick: () => setDockTab('preview') }, localeId === 'en' ? 'Run & verify' : '运行验收'),
                          h('button', { type: 'button', 'aria-pressed': dockTab === 'knowledge', onClick: () => setDockTab('knowledge') }, localeId === 'en' ? 'Project knowledge' : '项目知识')),
                        h(Button, { key: 'settings', size: 'xs', onClick: () => setSettingsOpen(true) }, localeId === 'en' ? 'Stage settings & approval' : '阶段设置与确认'),
                        h(Button, { key: 'start', size: 'xs', kind: 'primary', disabled: busy !== '' || running || isLocked(state, stage), disabledReason: busy !== '' ? '正在处理当前操作，请等待完成。' : running ? '当前阶段已有运行中的任务，请等待结束或先停止任务。' : '请先审阅并确认前序阶段文档，再开始当前阶段。',
                          onClick: () => start(stage) }, localeId === 'en' ? 'Start / continue' : '开始 / 继续'),
                      ]),
                      meta.phase === 'offline' ? h('p', { key: 'offline', role: 'alert', className: 'dshwb-banner dshwb-bannerWarn' }, copy.loadFailed) : null,
                      h('section', { key: 'workspace', className: 'dshwb-documentWorkspace' }, dockTab === 'knowledge'
                        ? h(KnowledgePanel, { key: `knowledge-${meta.projectRoot}-${state.boardId}-${stage}`, state, stage, localeId, refreshVersion: docsVersion, showToast,
                            onOpenDocument: (source) => { setPreferredDocument(source.path.split('/').pop()); if (source.stage) store.setStage(source.stage); setDockTab('docs'); } })
                        : dockTab === 'preview'
                        ? h(ProjectPreviewPane, { key: `preview-${state.boardId}`, state, copy, store, showToast })
                        : h(DocumentPane, { key: `document-${state.boardId}-${stage}-${preferredDocument}`, state, copy, stage, docsVersion, initialPath: preferredDocument,
                            onGenerateDocx: generateDocx, onRefresh: () => setDocsVersion((value) => value + 1), showToast, localeId,
                            onRequestChanges: (text) => modify(text, false) })),
                      h('details', { key: 'versions', className: 'dshwb-versionDetails' },
                        h('summary', null, localeId === 'en' ? 'Version details & approval history' : '文档版本与确认历史'),
                        h(ArtifactReviewPanel, { review, state, stage, localeId, onRefresh: () => setDocsVersion((value) => value + 1), showToast })),
                      h(WorkspaceDrawer, { key: 'settings', open: settingsOpen, onClose: () => setSettingsOpen(false), title: localeId === 'en' ? 'Project & stage settings' : '项目与阶段设置' }, [
                        h(Toast, { key: 'drawerToast', toast }),
                        h(ProjectSetup, { key: 'project', state, meta, copy, store, onSave: () => showToast(copy.saved, 'success'), onPickDirectory: props.pickDirectory, onNewRound: startNewRound }),
                        stageBody,
                        h(ModifyComposer, { key: 'modify', copy, busy, onModify: modify }),
                      ]),
                    ],
              ),
              h(ConversationDock, {
                key: 'dock',
                state,
                localeId,
                copy,
                stage,
                docsVersion,
                onGenerateDocx: generateDocx,
                onRefresh: () => setDocsVersion((value) => value + 1),
                showToast,
                onOpenSession: openSession,
                hasSession: Boolean(currentSessionId),
                stage,
                chatPane: h(ChatPane, {
                  sessionId: currentSessionId,
                  stage,
                  reference,
                  failed: sessionFailed,
                  copy,
                  SessionProvider: props.SessionProvider,
                  renderSlot: props.renderSlot,
                }),
              }),
              h(SplitHandle, {
                key: 'split-dock',
                side: 'dock',
                value: layout.dock,
                limits: LAYOUT_LIMITS.dock,
                dragging: dragging === 'dock',
                label: copy.layout.dockHandle,
                onDragStart: beginResize('dock'),
                onNudge: nudge('dock'),
                onReset: resetSide('dock'),
              }),
            ),
          ),
        ],
      );
    }

    /* ------------------------------------------------------------------
     * Compact conversation view
     * ---------------------------------------------------------------- */

    function WorkbenchView(props) {
      const { state, meta, store } = useWorkbench();
      const localeId = useLocaleId(props.localeRuntime);
      const copy = copyFor(localeId);
      const [toast, showToast] = useToast();
      const running = useRunning(props.useSessionStatus, state.sessionId);
      const stage = STAGES.includes(state.stage) ? state.stage : STAGES[0];
      const confirmedCount = STAGES.filter((key) => state.stageData[key].confirmed).length;

      return h(
        'div',
        { className: 'dshwb-surface dshwb-view', 'data-testid': 'workbench-view' },
        [
          h('style', { key: 'css' }, CSS),
          h(Toast, { key: 'toast', toast }),
          h(
            'div',
            { key: 'head', className: 'dshwb-viewHead' },
            h(
              'div',
              { key: 'left' },
              h(
                'div',
                { className: 'dshwb-viewTitleRow' },
                h(Icon, { name: 'spark', size: 16 }),
                h('strong', null, copy.appTitle),
                h('span', { className: 'dshwb-viewProgress' }, `${confirmedCount}/${STAGES.length}`),
                running ? h(StatusPill, { status: 'running', copy }) : null,
              ),
              h('p', { className: 'dshwb-viewProject' }, projectLabel(state, meta, copy)),
            ),
            h(
              'div',
              { key: 'right', className: 'dshwb-viewActions' },
              h(
                Button,
                {
                  kind: 'primary',
                  size: 'sm',
                  onClick: () => {
                    const pending = props.startStage(stage);
                    if (pending && typeof pending.then === 'function') {
                      pending.then(() => {
                        if (typeof props.openView === 'function') props.openView('chat', '');
                      });
                    }
                  },
                  disabled: running, disabledReason: '当前阶段已有运行中的任务，请等待结束或先停止任务。',
                },
                h(Icon, { name: 'play', size: 13 }),
                copy.action.start,
              ),
              h(
                Button,
                {
                  kind: 'secondary',
                  size: 'sm',
                  onClick: () => {
                    const targeted = sessionFor(state, stage);
                    if (!targeted) {
                      showToast(copy.toast.noSession, 'info');
                      return;
                    }
                    props.openSession(targeted);
                  },
                  disabled: !sessionFor(state, stage), disabledReason: '请先开始当前阶段，创建会话后再打开。',
                },
                copy.action.openSession,
              ),
              h(
                Button,
                { kind: 'secondary', size: 'sm', onClick: props.openFullWorkbench },
                h(Icon, { name: 'external', size: 13 }),
                copy.view.openFull,
              ),
            ),
          ),
          h(
            'div',
            { key: 'chips', className: 'dshwb-viewChips', role: 'tablist' },
            STAGES.map((key, index) => {
              const status = stageStatus(state, key);
              return h(
                'button',
                {
                  key,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': key === stage ? 'true' : 'false',
                  className: `dshwb-chip dshwb-viewChip${key === stage ? ' dshwb-viewChipActive' : ''}`,
                  onClick: () => store.setStage(key),
                },
                h(
                  'span',
                  { className: `dshwb-viewChipNum dshwb-viewChipNum-${status}` },
                  status === 'confirmed' ? h(Icon, { name: 'check', size: 10 }) : String(index + 1),
                ),
                copy.stage[key].short,
              );
            }),
          ),
          h(
            'div',
            { key: 'stage', className: 'dshwb-viewStage' },
            h(
              'div',
              { key: 'main' },
              h(
                'div',
                { key: 'titleRow', className: 'dshwb-viewStageTitleRow' },
                h('h3', null, copy.stage[stage].title),
                h(StatusPill, { status: stageStatus(state, stage), copy }),
              ),
              h('p', { key: 'desc' }, copy.stage[stage].desc),
              h(
                'div',
                { key: 'docs', className: 'dshwb-viewDocs' },
                stageDocs(state, stage).map((doc) =>
                  h(
                    'span',
                    { key: doc.path, className: 'dshwb-viewDoc' },
                    h(Icon, { name: 'doc', size: 11 }),
                    doc.path,
                  ),
                ),
              ),
            ),
            h(
              'div',
              { key: 'side', className: 'dshwb-viewSide' },
              h('p', { className: 'dshwb-viewHint' }, copy.view.hint),
              h('p', { className: 'dshwb-viewHint dshwb-muted' }, copy.view.full),
            ),
          ),
        ],
      );
    }

    /* ------------------------------------------------------------------
     * CSS
     * ---------------------------------------------------------------- */

    const CSS = `
.dshwb-surface {
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
}
.dshwb-surface *, .dshwb-surface *::before, .dshwb-surface *::after { box-sizing: border-box; }
.dshwb-page {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 20px 28px 44px;
  background:
    radial-gradient(1200px 420px at 18% -12%, color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent), transparent 70%),
    var(--dsw-alias-bg-base);
}
.dshwb-topbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  max-width: 1500px;
  margin: 0 auto 22px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshwb-brand { display: flex; align-items: flex-start; gap: 11px; min-width: 0; }
.dshwb-brandMark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  background: var(--dsw-alias-state-business-primary);
  color: #fff;
  box-shadow: 0 5px 18px color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
}
.dshwb-brandText { min-width: 0; }
.dshwb-brandText h1 {
  margin: 0 0 3px;
  font-size: 18px;
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.dshwb-brandText p {
  margin: 0;
  max-width: 620px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}
.dshwb-topbarMeta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding-top: 2px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.dshwb-topProject { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.dshwb-topProjectLabel { color: var(--dsw-alias-label-caption); }
.dshwb-topProject strong { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dshwb-saveState { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.dshwb-saveDot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.dshwb-saveState-saving .dshwb-saveDot { background: var(--dsw-alias-state-warn-primary); }
.dshwb-saveState-local .dshwb-saveDot { background: var(--dsw-alias-state-idle-primary); }
.dshwb-topProgress { display: inline-flex; align-items: center; gap: 7px; }
.dshwb-progressTrack {
  display: block;
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: 99px;
  background: var(--dsw-alias-border-l2);
}
.dshwb-progressTrack > span { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary); transition: width 240ms ease; }
.dshwb-progressTrackTop { width: 62px; height: 3px; }
.dshpm-templatePick { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; cursor: pointer; }
.dshpm-templatePick span:first-of-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshpm-templateBrief { flex: 1.4; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--dsw-alias-label-caption); }
.dshpm-templatePreview { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); max-height: 460px; overflow: auto; }
.dshpm-templatePreviewHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshpm-templatePreview details summary { cursor: pointer; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dshpm-templatePreview pre { white-space: pre-wrap; font-size: 10px; color: var(--dsw-alias-label-caption); }
.dshpm-template {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshpm-templateHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshpm-templateHead strong { font-size: 12px; color: var(--dsw-alias-label-primary); }
.dshpm-templateBadge { padding: 1px 8px; border-radius: 99px; font-size: 9.5px; background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.dshpm-templateBadgeWait { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dshpm-templateList { display: flex; flex-direction: column; gap: 4px; }
.dshpm-templateRow { display: flex; align-items: center; gap: 7px; padding: 5px 8px; border-radius: 8px; background: var(--dsw-alias-bg-base); font-size: 10.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshpm-templateRow span:first-of-type { flex: 1; color: var(--dsw-alias-label-primary); }
.dshpm-templateError { margin: 0; font-size: 10.5px; color: var(--dsw-alias-state-error-primary); }
.dshwb-team { display: flex; flex-direction: column; gap: 12px; }
.dshwb-teamAuto {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 9px 11px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dshwb-teamAutoText { font-weight: 560; }
.dshwb-teamAutoHint { color: var(--dsw-alias-label-caption); }
.dshwb-teamGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 10px; align-items: start; }
.dshwb-persona {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshwb-personaBusy { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }
.dshwb-personaHead { display: flex; align-items: center; gap: 9px; }
.dshwb-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 50%;
  box-shadow: 0 2px 8px color-mix(in srgb, #000 18%, transparent);
}
.dshwb-personaWho { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dshwb-personaWho strong { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshwb-personaWho span { font-size: 10px; color: var(--dsw-alias-label-caption); }
.dshwb-personaState { flex: none; padding: 1px 7px; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 9.5px; }
.dshwb-personaStateBusy { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
.dshwb-personaStateIdle { opacity: 0.7; }
.dshwb-personaIntro { margin: 0; font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-caption); }
.dshwb-personaTask { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 7px 9px; border-radius: 8px; background: var(--dsw-alias-bg-base); font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dshwb-personaTask strong { color: var(--dsw-alias-label-primary); font-size: 11.5px; }
.dshwb-personaIdle { color: var(--dsw-alias-label-caption); }
.dshwb-taskGuide { position:sticky; top:8px; z-index:8; display:flex; flex-wrap:wrap; gap:16px; justify-content:space-between; align-items:center; border:1px solid var(--dsw-alias-border-l1); border-left:4px solid #597ef7; border-radius:12px; padding:16px; margin-bottom:18px; background:var(--dsw-alias-bg-base); }
.dshwb-taskGuideBody { flex:1 1 240px; min-width:0; overflow-wrap:anywhere; }
.dshwb-taskGuideBody strong { display:block; font-size:16px; margin-bottom:6px; }
.dshwb-taskGuideBody p { margin:6px 0 0; font-size:12px; opacity:.75; }
.dshwb-taskGuideActions { display:flex; flex-wrap:wrap; gap:8px; }
.dshwb-queueDetails { margin:12px 0; font-size:12px; overflow-wrap:anywhere; }
.dshwb-queueDetails summary { cursor:pointer; padding:8px 0; line-height:1.6; }
.dshwb-queueDetails ol { margin:0; padding-left:16px; max-height:420px; overflow:auto; }
.dshwb-queueDetails li { padding:6px; border-top:1px solid var(--dsw-alias-border-l1); }
.dshwb-queueDetails p { margin:6px 0; }
.dshwb-personaQueue { display: flex; flex-wrap: wrap; gap: 8px; font-size: 9.5px; color: var(--dsw-alias-label-caption); }
.dshwb-personaWait { color: var(--dsw-alias-state-warn-primary); }
.dshwb-personaActions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: auto; }
.dshwb-roundBadge {
  flex: none;
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
  font-size: 9.5px;
  white-space: nowrap;
}
.dshwb-flowRow { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 10px; }
.dshwb-flowHint { margin: 0; color: var(--dsw-alias-label-caption); font-size: 10px; line-height: 1.5; }

.dshwb-shell {
  position: relative;
  display: grid;
  grid-template-columns: var(--dshwb-rail-width, 220px) minmax(0, 1fr);
  gap: 22px;
  max-width: 1500px;
  margin: 0 auto;
  align-items: start;
}
.dshwb-left { position: sticky; top: 0; display: flex; flex-direction: column; gap: 18px; }
.dshwb-rail { display: flex; flex-direction: column; gap: 14px; }
.dshwb-railProgress { padding: 12px 12px 11px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dshwb-railProgressHead { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dshwb-railProgressHead strong { font-size: 12px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dshwb-stageNav { display: flex; flex-direction: column; gap: 3px; }
.dshwb-stageItem {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  margin: 0;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dshwb-stageItem:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshwb-stageItemActive { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 2px 8px color-mix(in srgb, #000 5%, transparent); }
.dshwb-stageNum {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
  background: var(--dsw-alias-bg-base);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.dshwb-stageItem-confirmed .dshwb-stageNum { border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-primary); color: #fff; }
.dshwb-stageItem-started .dshwb-stageNum { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.dshwb-stageItemBody { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dshwb-stageItemBody strong { font-size: 12.5px; font-weight: 560; }
.dshwb-stageItemBody span { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.dshwb-railDot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--dsw-alias-border-l3); }
.dshwb-railDot-started { background: var(--dsw-alias-state-warn-primary); }
.dshwb-railDot-confirmed { background: var(--dsw-alias-state-success-primary); }
.dshwb-railGuide { padding: 12px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 11px; }
.dshwb-railGuideTitle { margin: 0 0 8px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshwb-railGuideStep { display: flex; gap: 7px; margin: 0 0 6px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-caption); }
.dshwb-railGuideStep > span:first-child { display: grid; place-items: center; flex: none; width: 15px; height: 15px; border-radius: 50%; background: var(--dsw-alias-bg-layer-2); font-size: 9px; color: var(--dsw-alias-label-secondary); }
.dshwb-activity { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 13px; }
.dshwb-activityTitle { margin: 0 0 8px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshwb-activityList { display: flex; flex-direction: column; gap: 9px; margin: 0; padding: 0; list-style: none; }
.dshwb-activityItem { display: flex; align-items: flex-start; gap: 7px; font-size: 10.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.dshwb-activityDot { width: 5px; height: 5px; flex: none; margin-top: 5px; border-radius: 50%; background: var(--dsw-alias-state-business-primary); }
.dshwb-activityItem-confirm .dshwb-activityDot { background: var(--dsw-alias-state-success-primary); }
.dshwb-activityItem-deploy .dshwb-activityDot { background: var(--dsw-alias-state-warn-primary); }
.dshwb-activityTime { display: block; font-size: 9.5px; color: var(--dsw-alias-label-caption); }
.dshwb-activityText { display: block; }

.dshwb-main { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) var(--dshwb-dock-width, 386px); gap: 20px; align-items: start; min-width: 0; }
.dshwb-split {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
}
.dshwb-split-rail { left: calc(var(--dshwb-rail-width, 220px) + 5px); }
.dshwb-split-dock { right: calc(var(--dshwb-dock-width, 386px) + 4px); }
.dshwb-splitLine {
  width: 2px;
  height: 100%;
  border-radius: 99px;
  background: var(--dsw-alias-border-l2);
  opacity: 0;
  transition: opacity 120ms ease;
}
.dshwb-split:hover .dshwb-splitLine,
.dshwb-splitActive .dshwb-splitLine { opacity: 1; }
.dshwb-splitActive .dshwb-splitLine { background: var(--dsw-alias-state-business-primary); }
.dshwb-split:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -3px; border-radius: 99px; }
.dshwb-dragShield { position: fixed; inset: 0; z-index: 60; cursor: col-resize; }
.dshwb-content { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.dshwb-dock {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  min-height: 420px;
  max-height: calc(100vh - 48px);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 8px 28px color-mix(in srgb, #000 6%, transparent);
}
.dshwb-dockTabs { display: flex; gap: 2px; flex: none; padding: 8px 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dshwb-dockTab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 11px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dshwb-dockTab:hover { color: var(--dsw-alias-label-primary); }
.dshwb-dockTabActive { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary); }
.dshwb-chatPane {
  display: flex;
  flex-direction: column;
  height: clamp(420px, calc(100vh - 150px), 860px);
  min-height: 0;
  overflow: hidden;
}
.dshwb-chatHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dshwb-chatContext { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.dshwb-chatRole { display: flex; align-items: center; gap: 8px; }
.dshwb-chatRequirement { max-width: 100%; padding: 3px 8px; border-radius: 7px; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; white-space: normal; color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary); }
.dshwb-chatHint { flex: 1; min-width: 0; font-size: 10px; line-height: 1.45; color: var(--dsw-alias-label-caption); }
.dshwb-chatScope {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 99px;
  color: var(--dsw-alias-label-secondary);
  font-size: 9.5px;
  white-space: nowrap;
}
.dshwb-chatScopeSpec {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.dshwb-chatOpen {
  flex: none;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.dshwb-chatOpen:hover:not([aria-disabled="true"]) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dshwb-btn[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.dshwb-chatOpen[aria-disabled="true"] { opacity: 0.5; cursor: default; }
.dshwb-chatMount { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.dshwb-chatHost { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.dshwb-chatBody { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.dshwb-chatEmpty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  min-height: 240px;
  padding: 24px;
  text-align: center;
  color: var(--dsw-alias-label-caption);
}
.dshwb-chatEmpty strong { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dshwb-chatEmpty span { max-width: 250px; font-size: 11px; line-height: 1.6; }
.dshwb-artifactReview { margin-bottom: 14px; overflow-wrap: anywhere; }
.dshwb-artifactReview li { margin: 6px 0; font-size: 12px; }
.dshwb-artifactReview summary { cursor: pointer; }
.dshwb-versionEntry { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshwb-docPane, .dshwb-previewPane { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.dshwb-docTabs { display: flex; flex-wrap: wrap; gap: 5px; flex: none; padding: 10px 12px 0; }
.dshwb-docTab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 99px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.dshwb-docTab:hover { color: var(--dsw-alias-label-primary); }
.dshwb-docTabActive { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent); }
.dshwb-docTab { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwb-docTabMissing { border-style: dashed; opacity: 0.62; }
.dshwb-docTabMissing.dshwb-docTabActive { opacity: 0.85; }
.dshwb-pdfFrame { width: 100%; height: 560px; min-height: 420px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-base); }
.dshwb-docMeta { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; padding: 9px 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshwb-docPath { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--dsw-alias-label-caption); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.dshwb-docActions { display: flex; gap: 4px; flex: none; }
.dshwb-docBody { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 18px; }
.dshwb-docStats { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 12px; padding-bottom: 9px; border-bottom: 1px dashed var(--dsw-alias-border-l1); font-size: 10px; color: var(--dsw-alias-label-caption); }
.dshwb-docBadge { padding: 2px 7px; border-radius: 99px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
.dshwb-docEmpty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; flex: 1; min-height: 260px; padding: 28px; text-align: center; color: var(--dsw-alias-label-caption); }
.dshwb-docEmpty strong { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dshwb-docEmpty span { max-width: 280px; font-size: 11px; line-height: 1.6; }
.dshwb-docEmpty code { max-width: 100%; padding: 3px 7px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); font-size: 10px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; }
.dshwb-docEmptyError { color: var(--dsw-alias-state-error-primary); }
.dshwb-reqCard { min-height: 320px; }
.dshwb-reqDeleteList { max-height:55dvh; overflow:auto; padding-left:20px; }
.dshwb-reqDeleteList li { margin:12px 0; }
.dshwb-reqDeleteList code { display:block; overflow-wrap:anywhere; font-size:11px; opacity:.7; margin-top:4px; }
.dshwb-reqSelection { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:0 0 12px; padding:10px; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; }
.dshwb-reqSelection label { display:inline-flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; }
.dshwb-reqSelection .dshwb-hint { flex-basis:100%; }
.dshwb-reqCheckbox { flex:none; align-self:flex-start; margin-top:4px; cursor:pointer; }
.dshwb-reqBar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 10px; }
.dshwb-reqCount { font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.dshwb-reqList { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dshwb-reqRow {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshwb-reqRow:hover { border-color: var(--dsw-alias-border-l2); }
.dshwb-reqMain { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.dshwb-reqTitleRow { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.dshwb-reqTitle { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshwb-reqStatus {
  padding: 1px 7px;
  border-radius: 99px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 9.5px;
}
.dshwb-reqStatus-active { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
.dshwb-reqStatus-done { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-success-primary); }
.dshwb-reqFlow {
  padding: 1px 7px;
  border-radius: 99px;
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
  font-size: 9.5px;
}
.dshwb-reqGone { font-size: 9.5px; color: var(--dsw-alias-state-error-primary); }
.dshwb-reqStage { margin: 0; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dshwb-reqGoal {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.dshwb-reqMeta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 2px 0 0; font-size: 9.5px; color: var(--dsw-alias-label-caption); }
.dshwb-reqRoot {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.dshwb-reqActions { display: flex; flex: none; flex-direction: column; gap: 4px; }
.dshwb-spinner { width: 16px; height: 16px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-state-business-primary); border-radius: 50%; animation: dshwb-spin 700ms linear infinite; }
@keyframes dshwb-spin { to { transform: rotate(360deg); } }

.dshwb-markdown { font-size: 12.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dshwb-markdown h2, .dshwb-markdown h3, .dshwb-markdown h4, .dshwb-markdown h5, .dshwb-markdown h6 { margin: 18px 0 7px; color: var(--dsw-alias-label-primary); line-height: 1.4; }
.dshwb-markdown h2 { font-size: 17px; font-weight: 650; padding-bottom: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshwb-markdown h3 { font-size: 14px; font-weight: 620; }
.dshwb-markdown h4 { font-size: 12.5px; font-weight: 620; }
.dshwb-markdown h5, .dshwb-markdown h6 { font-size: 12px; font-weight: 620; }
.dshwb-markdown p { margin: 0 0 8px; }
.dshwb-markdown ul, .dshwb-markdown ol { margin: 0 0 10px; padding-left: 20px; }
.dshwb-markdown li { margin: 2px 0; }
.dshwb-markdown code { padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-markdown-inline-code); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; color: var(--dsw-alias-label-primary); }
.dshwb-codeBlock { margin: 9px 0 12px; padding: 11px 12px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-markdown-code-block); font-size: 11px; line-height: 1.6; }
.dshwb-codeBlock code { padding: 0; background: transparent; font-size: inherit; }
.dshwb-tableWrap { max-width: 100%; margin: 9px 0 13px; overflow-x: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.dshwb-markdown table { width: 100%; border-collapse: collapse; font-size: 11px; line-height: 1.5; }
.dshwb-markdown th { padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 620; text-align: left; white-space: nowrap; }
.dshwb-markdown td { padding: 6px 8px; border-top: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.dshwb-markdown tr:first-child td { border-top: 0; }
.dshwb-markdown blockquote { margin: 8px 0; padding: 6px 10px; border-left: 2px solid var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dshwb-markdown hr { margin: 14px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshwb-markdown a { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
.dshwb-markdown a:hover { text-decoration: underline; }
.dshwb-plainDoc { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 12.5px; line-height: 1.75; color: var(--dsw-alias-label-secondary); }
.dshwb-codeDoc { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }

.dshwb-card {
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 13px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 0 color-mix(in srgb, #fff 3%, transparent);
}
.dshwb-sectionHead { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 13px; }
.dshwb-sectionIcon { display: grid; place-items: center; flex: none; width: 27px; height: 27px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); color: var(--dsw-alias-state-business-primary); }
.dshwb-sectionText { min-width: 0; flex: 1; }
.dshwb-sectionTitle { margin: 0 0 2px; font-size: 14px; font-weight: 630; line-height: 1.35; }
.dshwb-sectionDesc { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dshwb-sectionExtra { flex: none; padding-top: 2px; }
.dshwb-bodyText { margin: 0 0 13px; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dshwb-muted { color: var(--dsw-alias-label-caption); font-size: 10.5px; }
.dshwb-hint { margin: 9px 0 0; font-size: 10.5px; line-height: 1.55; color: var(--dsw-alias-label-caption); }

.dshwb-status { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); font-size: 10px; line-height: 1.3; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dshwb-statusDot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dshwb-status-started .dshwb-statusDot, .dshwb-status-running .dshwb-statusDot { background: var(--dsw-alias-state-warn-primary); }
.dshwb-status-running .dshwb-statusDot { animation: dshwb-pulse 1.3s ease-in-out infinite; }
.dshwb-status-confirmed { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.dshwb-status-confirmed .dshwb-statusDot { background: var(--dsw-alias-state-success-primary); }
@keyframes dshwb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.dshwb-input {
  display: block;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  outline: none;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 1.55;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dshwb-input::placeholder { color: var(--dsw-alias-label-caption); }
.dshwb-input:focus { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); }
textarea.dshwb-input { resize: vertical; }
.dshwb-textarea { min-height: 58px; }
.dshwb-bigTextarea { min-height: 168px; font-size: 12.5px; line-height: 1.7; }
.dshwb-goalInput { min-height: 52px; }
.dshwb-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dshwb-fieldLabel { font-size: 10.5px; font-weight: 560; color: var(--dsw-alias-label-secondary); }
.dshwb-fieldHint { font-size: 10px; color: var(--dsw-alias-label-caption); line-height: 1.5; }
.dshwb-fieldGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin-bottom: 11px; }
.dshwb-planSection { margin: 0 0 14px; }
.dshwb-planSwitch { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 0 0 12px; }
.dshwb-planSwitchHint { flex: 1; min-width: 200px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-caption); }
.dshwb-planGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.dshwb-planCard {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  margin: 0;
  padding: 10px 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 11px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.dshwb-planCard:hover { border-color: var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-2); }
.dshwb-planCardActive { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent); }
.dshwb-planHead { display: flex; align-items: center; gap: 6px; }
.dshwb-planHead strong { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshwb-planTag { padding: 1px 6px; border-radius: 99px; background: var(--dsw-alias-state-business-primary); color: #fff; font-size: 9px; }
.dshwb-planTagline { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-caption); }
.dshwb-planMeta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; font-size: 9.5px; color: var(--dsw-alias-label-caption); }
.dshwb-planDetail { margin-top: 10px; padding: 12px 13px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); }
.dshwb-planDetailHead strong { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshwb-planDetailHead p { margin: 3px 0 0; font-size: 10.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dshwb-planStackTitle { margin: 11px 0 4px; font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshwb-planStack { display: flex; flex-direction: column; gap: 3px; margin: 0; }
.dshwb-planStackRow { display: flex; gap: 8px; font-size: 10.5px; line-height: 1.5; }
.dshwb-planStackRow dt { flex: none; width: 56px; color: var(--dsw-alias-label-caption); }
.dshwb-planStackRow dd { margin: 0; color: var(--dsw-alias-label-secondary); }
.dshwb-planCompare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 11px; padding-top: 10px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.dshwb-planCol h5 { margin: 0 0 5px; font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshwb-planCol ul { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
.dshwb-planCol li { position: relative; padding-left: 11px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dshwb-planCol li::before { content: ''; position: absolute; left: 2px; top: 6px; width: 3px; height: 3px; border-radius: 50%; background: var(--dsw-alias-border-l4); }
.dshwb-planCol:first-child li::before { background: var(--dsw-alias-state-success-primary); }
.dshwb-planCol:last-child li::before { background: var(--dsw-alias-state-warn-primary); }
.dshwb-planFit { margin: 10px 0 0; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-caption); }
.dshwb-deployGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }

.dshwb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  font: inherit;
  font-weight: 520;
  cursor: pointer;
  white-space: nowrap;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dshwb-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dshwb-btn[disabled] { opacity: 0.45; cursor: default; }
.dshwb-btn-md { height: 32px; padding: 0 13px; font-size: 12px; }
.dshwb-btn-sm { height: 28px; padding: 0 10px; font-size: 11px; }
.dshwb-btn-xs { height: 24px; padding: 0 7px; font-size: 10px; border-radius: 6px; }
.dshwb-btn-primary { background: var(--dsw-alias-state-business-primary); color: #fff; }
.dshwb-btn-primary:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 88%, #000); }
.dshwb-btn-secondary { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dshwb-btn-secondary:hover { background: var(--dsw-alias-bg-layer-2); }
.dshwb-btn-ghost { background: transparent; color: var(--dsw-alias-label-secondary); }
.dshwb-btn-ghost:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshwb-actionsRow { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 12px; }
.dshwb-rowEnd { display: flex; justify-content: flex-end; }
.dshwb-iconBtn { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-caption); cursor: pointer; }
.dshwb-iconBtn:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }

.dshwb-checkRow { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px; margin: 0 0 6px; border: 1px solid transparent; border-radius: 8px; cursor: pointer; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); transition: background 120ms ease, border-color 120ms ease; }
.dshwb-checkRow:hover { background: var(--dsw-alias-bg-layer-2); }
.dshwb-checkRowOn { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 25%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 6%, transparent); }
.dshwb-checkRow input { position: absolute; opacity: 0; pointer-events: none; }
.dshwb-checkBox { display: grid; place-items: center; width: 15px; height: 15px; flex: none; margin-top: 1px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 4px; background: var(--dsw-alias-bg-base); color: #fff; }
.dshwb-checkRowOn .dshwb-checkBox { border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-primary); }
.dshwb-checkLabel { flex: 1; }
.dshwb-checkList { margin: 0; padding: 0; list-style: none; }
.dshwb-checkItem { display: flex; align-items: flex-start; gap: 6px; }
.dshwb-checkItem .dshwb-checkRow { flex: 1; }
.dshwb-inlineForm { display: flex; gap: 6px; margin-top: 7px; }
.dshwb-gateBlock {
  margin: 2px 0 12px;
  padding: 10px 11px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
}
.dshwb-gateHead { display: flex; flex-direction: column; gap: 2px; margin-bottom: 7px; }
.dshwb-gateHead strong { color: var(--dsw-alias-label-primary); font-size: 11.5px; }
.dshwb-gateHint { color: var(--dsw-alias-label-caption); font-size: 10px; line-height: 1.5; }
.dshwb-gateList { display: flex; flex-direction: column; gap: 4px; margin: 0 0 8px; padding: 0; list-style: none; }
.dshwb-gateItem { display: flex; align-items: flex-start; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 10.5px; line-height: 1.5; }
.dshwb-gateDot { flex: none; width: 5px; height: 5px; margin-top: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); }
.dshwb-confirmBlock { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshwb-confirmBlock .dshwb-checkRow { width: 100%; }

.dshwb-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }
.dshwb-toolbarLeft { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dshwb-counter { flex: none; font-size: 10px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dshwb-sourceTag { display: inline-flex; align-items: center; gap: 4px; max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 7px; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dshwb-promptPreview { margin: 10px 0 0; max-height: 240px; overflow: auto; padding: 10px 12px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 10.5px; line-height: 1.55; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); }
.dshwb-banner { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dshwb-bannerWarn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent); }
.dshwb-locked { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 42px 24px; text-align: center; color: var(--dsw-alias-label-caption); }
.dshwb-locked h3 { margin: 2px 0 0; font-size: 14px; color: var(--dsw-alias-label-primary); }
.dshwb-locked p { margin: 0 0 7px; max-width: 360px; font-size: 11.5px; line-height: 1.6; }

.dshwb-projectBar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 2px; }
.dshwb-projectBarName { font-size: 11px; font-weight: 560; color: var(--dsw-alias-label-secondary); }
.dshwb-projectSetup { padding: 15px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dshwb-projectSetupHead { display: flex; align-items: center; gap: 7px; margin-bottom: 11px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dshwb-rootField { margin-bottom: 11px; }
.dshwb-rootField .dshwb-input { flex: 1; }
.dshwb-stageHead { padding: 2px 2px 0; }
.dshwb-eyebrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 10px; font-weight: 560; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dsw-alias-label-caption); }
.dshwb-eyebrowSep { opacity: 0.5; }
.dshwb-stageTitleRow { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.dshwb-stageTitle { margin: 0; font-size: 23px; line-height: 1.25; font-weight: 660; letter-spacing: -0.02em; }
.dshwb-stageDesc { margin: 5px 0 0; max-width: 700px; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }

.dshwb-segmented { display: inline-flex; flex-wrap: wrap; max-width: 100%; gap: 2px; padding: 3px; margin-bottom: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dshwb-segment { display: inline-flex; align-items: center; justify-content: center; flex: none; min-height: 26px; line-height: 1.5; white-space: nowrap; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10.5px; cursor: pointer; }
.dshwb-segmentActive { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 3px color-mix(in srgb, #000 8%, transparent); }
.dshwb-deployAuth { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; padding-top: 6px; }

.dshwb-previewForm { flex: none; padding: 10px 12px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshwb-previewUrlRow { display: flex; gap: 6px; }
.dshwb-previewTools { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.dshwb-linkBtn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border-radius: 6px; color: var(--dsw-alias-label-secondary); font-size: 10px; text-decoration: none; }
.dshwb-linkBtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshwb-deviceSwitch { display: inline-flex; gap: 1px; margin-left: auto; padding: 2px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.dshwb-deviceBtn { width: 24px; height: 20px; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-caption); font-size: 10px; cursor: pointer; }
.dshwb-deviceBtnActive { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dshwb-previewStatus { margin: 6px 0 0; font-size: 10px; line-height: 1.45; color: var(--dsw-alias-label-caption); }
.dshwb-frameWrap { flex: 1; min-height: 0; display: flex; justify-content: center; overflow: auto; padding: 10px; background: var(--dsw-alias-bg-layer-2); }
.dshwb-frame { width: 100%; height: 100%; min-height: 300px; border: 0; border-radius: 8px; background: #fff; box-shadow: 0 2px 14px color-mix(in srgb, #000 10%, transparent); }
.dshwb-previewEmpty { min-height: 280px; }
.dshwb-quickPorts { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; margin-top: 5px; }
.dshwb-previewHint { flex: none; margin: 0; padding: 8px 12px 10px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 9.5px; line-height: 1.55; color: var(--dsw-alias-label-caption); }

.dshwb-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 99px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10px; cursor: pointer; }
.dshwb-chip:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.dshwb-composer { margin-top: 4px; padding: 14px 15px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dshwb-composerHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.dshwb-composerTitle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 620; }
.dshwb-composerHintText { font-size: 10px; color: var(--dsw-alias-label-caption); }
.dshwb-composerInput { min-height: 62px; }
.dshwb-quickRow { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.dshwb-quickRow .dshwb-chip { font-size: 9.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshwb-composerActions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }
.dshwb-steer { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-caption); cursor: pointer; }
.dshwb-steer input { accent-color: var(--dsw-alias-state-business-primary); }

.dshwb-toast {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 80;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  max-width: min(420px, calc(100vw - 36px));
  padding: 10px 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  font-size: 11.5px;
  line-height: 1.5;
  box-shadow: 0 10px 30px color-mix(in srgb, #000 22%, transparent);
  animation: dshwb-toastIn 150ms ease-out;
}
.dshwb-toast-success svg { color: var(--dsw-alias-state-success-primary); }
.dshwb-toast-error svg { color: var(--dsw-alias-state-error-secondary); }
@keyframes dshwb-toastIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

.dshwb-view { padding: 12px 22px 16px; }
.dshwb-viewHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.dshwb-viewTitleRow { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.dshwb-viewProgress { font-size: 10px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dshwb-viewProject { margin: 2px 0 0 23px; font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.dshwb-viewActions { display: flex; gap: 6px; flex: none; }
.dshwb-viewChips { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px; margin-bottom: 10px; }
.dshwb-viewChip { flex: none; }
.dshwb-viewChipActive { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent); }
.dshwb-viewChipNum { display: grid; place-items: center; width: 13px; height: 13px; border-radius: 50%; background: var(--dsw-alias-bg-layer-2); font-size: 8px; }
.dshwb-viewChipNum-confirmed { background: var(--dsw-alias-state-success-primary); color: #fff; }
.dshwb-viewStage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, 0.65fr); gap: 14px; padding: 12px 13px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); }
.dshwb-viewStageTitleRow { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.dshwb-viewStage h3 { margin: 0; font-size: 14px; }
.dshwb-viewStage p { margin: 4px 0 0; font-size: 10.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dshwb-viewDocs { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.dshwb-viewDoc { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); font-size: 9.5px; color: var(--dsw-alias-label-caption); }
.dshwb-viewSide { padding-left: 12px; border-left: 1px solid var(--dsw-alias-border-l1); }
.dshwb-viewHint { margin: 0 0 5px; font-size: 9.5px; line-height: 1.5; color: var(--dsw-alias-label-caption); }

@media (max-width: 1260px) {
  .dshwb-main { grid-template-columns: minmax(0, 1fr); }
  .dshwb-split-dock { display: none; }
  .dshwb-dock { position: relative; max-height: 640px; }
}
@media (max-width: 980px) {
  .dshwb-shell { grid-template-columns: minmax(0, 1fr); }
  .dshwb-split-rail { display: none; }
  .dshwb-left { position: static; }
  .dshwb-stageNav { flex-direction: row; overflow-x: auto; padding-bottom: 2px; }
  .dshwb-stageItem { width: auto; flex: none; }
  .dshwb-stageItemBody span, .dshwb-railDot, .dshwb-railProgress, .dshwb-railGuide, .dshwb-activity { display: none; }
  .dshwb-stageItemBody { flex: none; }
  .dshwb-page { padding: 16px 16px 36px; }
  .dshwb-topbar { flex-direction: column; gap: 10px; }
  .dshwb-topbarMeta { justify-content: flex-start; }
  .dshwb-stageTitle { font-size: 20px; }
}
@media (max-width: 700px) {
  .dshwb-fieldGrid, .dshwb-deployGrid { grid-template-columns: minmax(0, 1fr); }
  .dshwb-reqRow { flex-wrap: wrap; }
  .dshwb-reqMain { flex:1 1 220px; min-width:0; }
  .dshwb-reqActions { flex-direction: row; flex-wrap: wrap; }
  .dshwb-planGrid, .dshwb-planCompare { grid-template-columns: minmax(0, 1fr); }
  .dshwb-viewStage { grid-template-columns: minmax(0, 1fr); }
  .dshwb-viewSide { padding-left: 0; padding-top: 8px; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l1); }
  .dshwb-composerHead { display: block; }
  .dshwb-composerHintText { display: block; margin-top: 3px; }
  .dshwb-dock { max-height: 560px; }
  .dshwb-topbarMeta .dshwb-topProgress { display: none; }
}
/* Batch 2: artifact-centered workspace; conversation is always a sibling. */
.dshwb-workspaceToolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* Keep tab containers separate from the legacy .dshwb-segment buttons. */
.dshwb-workspaceToolbar .dshwb-tabGroup { margin-right: auto; }
.dshwb-tabGroup { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; max-width: 100%; padding: 3px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dshwb-tabGroup > button { display: inline-flex; align-items: center; justify-content: center; flex: none; min-height: 30px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); padding: 6px 10px; font: inherit; font-size: 12px; line-height: 1.5; white-space: nowrap; cursor: pointer; }
.dshwb-tabGroup > button:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 65%, transparent); }
.dshwb-tabGroup > button[aria-pressed="true"] { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 1px 4px #0001; }
.dshwb-tabGroup > button:focus-visible, .dshwb-segment:focus-visible, .dshwb-docTab:focus-visible, .dshwb-paragraphComment:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dshwb-documentWorkspace { display: flex; flex-direction: column; min-width: 0; min-height: 520px; height: min(920px, calc(100dvh - 230px)); overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 13px; background: var(--dsw-alias-bg-layer-1); }
.dshwb-documentWorkspace > .dshwb-docPane, .dshwb-documentWorkspace > .dshwb-previewPane { min-height: 0; flex: 1; }
.dshwb-documentWorkspace .dshwb-docTabs { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 5px; }
.dshwb-docTab { flex: none; }
.dshwb-reviewDocument { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; }
.dshwb-reviewToolbar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dshwb-reviewBaseline { padding: 10px 16px; font-size: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshwb-reviewBaseline select { max-width: 100%; padding: 5px; color: inherit; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; font: inherit; }
.dshwb-reviewBody { padding: 16px 18px; }
.dshwb-reviewParagraph { position: relative; border: 1px solid transparent; border-radius: 8px; padding: 8px 10px 32px; margin: 0 0 9px; }
.dshwb-reviewParagraph:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dshwb-reviewParagraphSelected { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent); }
.dshwb-reviewParagraph .dshwb-markdown > :first-child { margin-top: 0; }
.dshwb-reviewParagraph .dshwb-markdown > :last-child { margin-bottom: 0; }
.dshwb-paragraphComment { position: absolute; bottom: 4px; right: 8px; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-state-business-primary); font: inherit; font-size: 11px; padding: 4px 7px; cursor: pointer; }
.dshwb-paragraphComment[aria-disabled="true"] { opacity: .45; cursor: default; }
.dshwb-reviewComments { padding: 16px 18px 22px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dshwb-reviewCommentsHead { display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; font-size: 13px; }
.dshwb-reviewComment, .dshwb-commentForm { margin-top: 12px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.dshwb-reviewComments blockquote { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; padding-left: 10px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshwb-commentText { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.dshwb-commentStale { color: #a55d08; font-size: 12px; }
.dshwb-commentForm label { display: block; margin: 10px 0; font-size: 12px; }
.dshwb-commentForm .dshwb-btn { margin-right: 7px; }
.dshwb-diffView { overflow-x: auto; }
.dshwb-diffCount { font: 12px var(--dsw-font-mono, monospace); }
.dshwb-diffTable { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
.dshwb-diffTable th { text-align: left; padding: 6px; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshwb-diffTable th:first-child, .dshwb-diffTable th:nth-child(2) { width: 34px; }
.dshwb-diffTable td { padding: 3px 6px; vertical-align: top; font-variant-numeric: tabular-nums; }
.dshwb-diffTable td:nth-child(1), .dshwb-diffTable td:nth-child(2) { color: var(--dsw-alias-label-caption); text-align: right; }
.dshwb-diffTable code { white-space: pre-wrap; overflow-wrap: anywhere; }
.dshwb-diffSign { display: inline-block; width: 16px; }
.dshwb-diff-add { background: #16804616; }
.dshwb-diff-remove { background: #d43c3c16; }
.dshwb-diff-skip { color: var(--dsw-alias-label-caption); background: var(--dsw-alias-bg-layer-2); }
.dshwb-reviewEmpty { padding: 20px 0; color: var(--dsw-alias-label-secondary); }
.dshwb-versionDetails > summary { padding: 8px 0; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshwb-settingsDrawer { position: fixed; inset: 0 0 0 auto; width: min(740px, 96vw); max-width: 96vw; height: 100dvh; max-height: 100dvh; padding: 0; margin: 0; border: 0; border-left: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.dshwb-settingsDrawer::backdrop { background: #0005; }
.dshwb-settingsDrawer > header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dshwb-settingsDrawer h2 { font-size: 16px; margin: 0; }
.dshwb-settingsContent { display: flex; flex-direction: column; gap: 16px; padding: 20px; }
@media (min-width: 1100px) {
  .dshwb-main { grid-template-columns: minmax(0, 1fr) var(--dshwb-dock-width, 386px); }
  .dshwb-split-dock { display: block; }
  .dshwb-dock { position: sticky; max-height: calc(100dvh - 48px); }
}
@media (max-width: 1099px) {
  .dshwb-main { grid-template-columns: minmax(0, 1fr); }
  .dshwb-split-dock { display: none; }
  .dshwb-dock { position: relative; max-height: 600px; }
}
@media (max-width: 640px) {
  .dshwb-documentWorkspace { min-height: 400px; height: 70dvh; }
  .dshwb-reviewBody, .dshwb-reviewComments { padding: 10px; }
  .dshwb-reviewToolbar { padding: 8px; }
  .dshwb-settingsContent { padding: 12px; }
}
/* Batch 3: searchable knowledge, traceability and inspectable Agent inputs. */
.dshwb-knowledgePanel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 22px; gap: 12px; }
.dshwb-knowledgeNav, .dshwb-knowledgeActions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dshwb-knowledgeNav { justify-content: space-between; position: sticky; top: -14px; z-index: 1; background: var(--dsw-alias-bg-layer-1); padding: 8px 0; }
.dshwb-knowledgeSummary { font-size: 13px; font-weight: 600; margin: 0; }
.dshwb-knowledgeFilters { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; }
.dshwb-knowledgePanel select, .dshwb-knowledgePanel input[type="number"] { color: inherit; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 7px; font: inherit; font-size: 12px; max-width: 100%; }
.dshwb-knowledgeList { padding: 0; margin: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.dshwb-knowledgeList > li > button { width: 100%; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; text-align: left; background: var(--dsw-alias-bg-layer-1); color: inherit; padding: 10px; cursor: pointer; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; font: inherit; font-size: 12px; }
.dshwb-knowledgeList > li > button[aria-pressed="true"] { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent); }
.dshwb-knowledgeList small { grid-column: 1 / -1; color: var(--dsw-alias-label-secondary); }
.dshwb-knowledgeList span, .dshwb-knowledgeSource, .dshwb-knowledgeDetail { overflow-wrap: anywhere; }
.dshwb-knowledgeForm, .dshwb-knowledgeDetail { padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.dshwb-knowledgePanel h3 { font-size: 14px; margin: 0 0 10px; }
.dshwb-knowledgePanel h4 { font-size: 12px; margin: 14px 0 8px; }
.dshwb-knowledgeForm label { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; font-size: 12px; }
.dshwb-knowledgeForm fieldset { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; margin-bottom: 10px; font-size: 12px; }
.dshwb-knowledgeFields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dshwb-knowledgeText, .dshwb-contextText { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.65; margin: 10px 0; max-height: 360px; overflow: auto; padding: 10px; background: var(--dsw-alias-bg-layer-1); border-radius: 7px; }
.dshwb-knowledgeSource { display: flex; flex-direction: column; align-items: start; gap: 6px; padding: 10px 0; }
.dshwb-knowledgeSource code, .dshwb-contextSource code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dshwb-knowledgeSource small { color: var(--dsw-alias-label-secondary); }
.dshwb-knowledgeNotice { margin: 12px 0; border-left: 3px solid var(--dsw-alias-state-business-primary); padding-left: 10px; font-size: 12px; }
.dshwb-knowledgeEdge { display: flex; flex-wrap: wrap; align-items: center; font-size: 12px; padding: 4px 0; }
.dshwb-knowledgeEdge > button, .dshwb-knowledgeWarnings button { border: 0; background: transparent; color: var(--dsw-alias-state-business-primary); cursor: pointer; padding: 3px; font: inherit; text-align: left; }
.dshwb-knowledgeLinkForm { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.dshwb-knowledgeLinkForm input { flex: 1; min-width: 120px; }
.dshwb-knowledgeWarnings { padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; font-size: 12px; }
.dshwb-knowledgeWarnings ul { padding-left: 20px; max-height: 220px; overflow: auto; }
.dshwb-knowledgePanel summary { cursor: pointer; font-size: 12px; }
.dshwb-contextBudget { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; }
.dshwb-contextBudget input { width: 100px; }
.dshwb-contextSource { display: flex; align-items: start; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 12px; }
.dshwb-contextSource input { margin-top: 3px; }
.dshwb-contextSource span { min-width: 0; }
.dshwb-contextSource small { display: block; margin: 3px 0; color: var(--dsw-alias-label-secondary); }
.dshwb-contextEntries { font-size: 11px; padding-left: 18px; max-height: 260px; overflow: auto; }
.dshwb-contextInspector > details, .dshwb-contextInspector > .dshwb-knowledgeActions { margin-top: 12px; }
@media (max-width: 640px) {
  .dshwb-knowledgePanel { padding: 10px; }
  .dshwb-knowledgeFilters { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .dshwb-knowledgeFilters input { grid-column: 1 / -1; }
  .dshwb-knowledgeFields { grid-template-columns: minmax(0, 1fr); }
}
`;

    const MANAGER_CSS = `
.dshpm-page { max-width: 1680px; margin: 0 auto; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scroll-padding-bottom: 40px; padding: 28px 28px max(40px, calc(28px + env(safe-area-inset-bottom))); color: var(--dsw-alias-label-primary); font: 14px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
.dshpm-page *, .dshpm-page *::before, .dshpm-page *::after { box-sizing: border-box; }
.dshpm-header { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-bottom: 24px; }
.dshpm-eyebrow { color: var(--dsw-alias-state-business-primary); font-size: 13px; margin: 0; }
.dshpm-page h1 { font-size: 26px; line-height: 1.4; margin: 4px 0; }
.dshpm-page h2 { font-size: 18px; margin: 0 0 14px; }
.dshpm-page h3 { font-size: 15px; margin: 0 0 8px; }
.dshpm-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dshpm-page .dshwb-btn { font-size: 13px; min-height: 34px; white-space: normal; }
.dshpm-setup { max-width: 900px; margin: 24px auto; padding: 26px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); }
.dshpm-goals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
.dshpm-goals button { font: inherit; text-align: left; color: inherit; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px; cursor: pointer; }
.dshpm-goals button strong, .dshpm-goals button span { display: block; }
.dshpm-goals button span { color: var(--dsw-alias-label-secondary); margin-top: 6px; font-size: 13px; }
.dshpm-goals button[aria-pressed="true"] { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, var(--dsw-alias-bg-layer-1)); }
.dshpm-page label { display: block; margin: 10px 0; }
.dshpm-page input[type="checkbox"] { margin-right: 8px; accent-color: var(--dsw-alias-state-business-primary); }
.dshpm-page textarea, .dshpm-page input { font: inherit; }
.dshpm-page textarea { resize: vertical; }
.dshpm-page button:focus-visible, .dshpm-page summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.dshpm-layout { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(0, 1.2fr); gap: 20px; align-items: start; }
.dshpm-conversation, .dshpm-results { min-width: 0; padding: 22px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); }
.dshpm-results > .dshwb-tabGroup { margin-bottom: 20px; }
.dshpm-messages { max-height: min(54dvh, 520px); min-height: 120px; overflow: auto; padding: 2px; }
.dshpm-msgHeading { margin: 12px 0 6px !important; font-size: 13.5px !important; font-weight: 620; color: var(--dsw-alias-label-primary); letter-spacing: 0.01em; }
.dshpm-msgList { margin: 4px 0 10px; padding-left: 20px; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dshpm-msgList li { margin: 3px 0; }
.dshpm-msgList li::marker { color: var(--dsw-alias-label-caption); }
.dshpm-askBadge { display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 99px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); font-size: 9.5px; font-weight: 560; vertical-align: 1px; }
.dshpm-messageText { white-space: pre-wrap; }
.dshpm-question {
  margin: 10px 0 !important;
  padding: 11px 13px !important;
  border-left: 3px solid var(--dsw-alias-state-business-primary);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, var(--dsw-alias-bg-layer-1));
  font-size: 15px !important;
  line-height: 1.6;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
}
.dshpm-question strong { font-weight: 700; }

.dshpm-scopeNotice { border-left: 3px solid #4377ce; padding: 10px 14px; background: var(--dsw-alias-bg-layer-2); }
.dshpm-simple .dshwb-btn-md,.dshpm-setup .dshwb-btn-md { min-height: 40px; height: auto; white-space: normal; padding-top: 8px; padding-bottom: 8px; }
.dshpm-setup .dshpm-goals button { min-height: 110px; }
.dshpm-simple .dshpm-composer textarea,.dshpm-setup input,.dshpm-setup textarea,.dshpm-setup select { font-size: 16px; }
@media(max-width:600px) { .dshpm-actions { flex-wrap:wrap; } .dshpm-header .dshwb-tabGroup { flex-wrap:wrap; } .dshpm-actionCard { padding:16px; } }
.dshpm-reader { border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; padding: 0; width: min(1080px,calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.dshpm-reader::backdrop { background: #172b4d66; }
.dshpm-readerHead { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 22px; position: sticky; top: 0; z-index: 2; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshpm-reader-full { position: static; padding: 0; border: 0; margin: 0; width: 100%; max-width: none; max-height: none; color: inherit; background: transparent; overflow: visible; }
.dshpm-readingHints { background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 12px 16px; margin: 12px 0; }
.dshpm-advanced { padding: 12px 0; }
.dshpm-advanced > summary { cursor: pointer; font-weight: 600; }
@media(max-width:600px) { .dshpm-reader { width:100vw; max-height:100dvh; height:100dvh; margin:0; border-radius:0; } }
.dshpm-simple .dshpm-layout { display: flex; flex-direction: column; max-width: 960px; margin: 16px auto; align-items: stretch; }
.dshpm-simple > .dshpm-actions { max-width: 960px; margin: 0 auto; }
.dshpm-actionCard { max-width: 960px; margin: 20px auto; padding: 22px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; }
.dshpm-actionCard h2 { margin: 5px 0 10px; font-size: 22px; }
.dshpm-actionCard .dshpm-actions { margin-top: 12px; }
.dshpm-planText { white-space: pre-wrap; margin: 12px 0; }
.dshpm-simple .dshpm-messages { max-height: 360px; }
.dshpm-more { position: relative; }
.dshpm-more summary { cursor: pointer; padding: 6px; }
.dshpm-more[open] { display: flex; flex-wrap: wrap; gap: 8px; }
.dshpm-message { font-size: 15px; line-height: 1.75; overflow-wrap: anywhere; }
.dshpm-message .dshpm-markdown p { margin: .65em 0; white-space: normal; }
.dshpm-markdown h1,.dshpm-markdown h2,.dshpm-markdown h3 { font-size: 1.08em; margin: 1em 0 .4em; }
.dshpm-markdown ul,.dshpm-markdown ol { padding-left: 1.6em; }
.dshpm-markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.dshpm-markdown td,.dshpm-markdown th { border: 1px solid #8885; padding: 6px 10px; }
.dshpm-markdown pre { overflow-x: auto; padding: 12px; background: #8881; }
.dshpm-summary { font-weight: 600; border-left: 3px solid #6586dc; padding-left: 12px; }
.dshpm-message details { margin-top: 12px; }
.dshpm-message details summary { cursor: pointer; font-weight: 600; }
.dshpm-question textarea { width: 100%; box-sizing: border-box; margin: 8px 0; }
.dshpm-message { padding: 14px; margin-bottom: 12px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2); overflow-wrap: anywhere; }
.dshpm-message p { white-space: pre-wrap; margin: 6px 0 0; }
.dshpm-message p:first-of-type { margin-top: 4px; }
.dshpm-message > strong { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshpm-message-user { margin-left: 24px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1)); }
.dshpm-progress { display: flex; flex-direction: column; gap: 8px; }
.dshpm-progressHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dshpm-progressHead strong { font-size: 13px; }
.dshpm-progressTime { font-size: 11px; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.dshpm-steps { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0; list-style: none; }
.dshpm-step { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-caption); }
.dshpm-stepDot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 10px;
  color: var(--dsw-alias-label-caption);
}
.dshpm-step-done .dshpm-stepDot { background: var(--dsw-alias-state-success-tertiary); border-color: transparent; color: var(--dsw-alias-state-success-primary); }
.dshpm-step-done .dshpm-stepText { color: var(--dsw-alias-label-secondary); }
.dshpm-step-current .dshpm-stepDot { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); }
.dshpm-step-current .dshpm-stepText { color: var(--dsw-alias-label-primary); font-weight: 560; }
.dshpm-step-failed .dshpm-stepDot { border-color: transparent; background: var(--dsw-alias-state-error-tertiary); color: var(--dsw-alias-state-error-primary); }
.dshpm-step-failed .dshpm-stepText { color: var(--dsw-alias-state-error-primary); }
.dshpm-stepError { margin: 0; font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.dshpm-notice, .dshpm-proposal, .dshpm-approval { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); padding: 16px; border-radius: 12px; margin: 14px 0; overflow-wrap: anywhere; }
.dshpm-proposalHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dshpm-proposalHead h3 { margin: 0; }
.dshpm-proposalStage { font-size: 10px; padding: 1px 8px; border-radius: 99px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.dshpm-proposalList { margin: 10px 0 12px; padding-left: 18px; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.dshpm-proposalList li { margin: 4px 0; }
.dshpm-proposalList li::marker { color: var(--dsw-alias-state-business-primary); }
.dshpm-proposal { border-color: var(--dsw-alias-state-business-primary); }
.dshpm-proposal p { white-space: pre-wrap; }
.dshpm-files { display: grid; gap: 8px; margin: 16px 0; }
.dshpm-files article { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 8px; overflow-wrap: anywhere; }
.dshpm-files span { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-right: auto; }
.dshpm-document { height: 540px; min-height: 350px; }
.dshpm-empty { padding: 45px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dshpm-record { border-top: 1px solid var(--dsw-alias-border-l1); padding: 12px 0; }
.dshpm-revise { margin: 18px 0; }
.dshpm-revise summary { cursor: pointer; }
.dshpm-page .dshwb-chip[aria-pressed="true"] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
@media(max-width: 1000px) { .dshpm-layout { grid-template-columns: minmax(0, 1fr); } .dshpm-header { flex-wrap: wrap; } }
@media(max-width: 600px) { .dshpm-page { padding: 14px 14px max(28px, calc(14px + env(safe-area-inset-bottom))); } .dshpm-goals { grid-template-columns: minmax(0, 1fr); } .dshpm-setup, .dshpm-conversation, .dshpm-results { padding: 16px; } .dshpm-page h1 { font-size: 22px; } .dshpm-document { height: 460px; } }

/* Conversation-first simple mode: a single scroll area, stable composer and contextual decisions. */
.dshpm-srOnly { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.dshpm-simple { display:flex; flex-direction:column; padding:16px 24px max(12px,env(safe-area-inset-bottom)); overflow:hidden; background:var(--dsw-alias-bg-layer-1); }
.dshpm-simple .dshpm-header { flex:none; margin:0; padding-bottom:14px; border-bottom:1px solid var(--dsw-alias-border-l1); gap:12px; }
.dshpm-simple .dshpm-header h1 { font-size:19px; }
.dshpm-simple .dshpm-header .dshpm-eyebrow { display:none; }
.dshpm-simple .dshpm-header .dshwb-hint { margin:3px 0 0; font-size:12px; }
.dshpm-simple .dshpm-layout { flex:1; min-height:0; width:100%; max-width:820px; margin:0 auto; gap:0; }
.dshpm-simple .dshpm-conversation { display:flex; flex:1; min-height:0; flex-direction:column; padding:0; border:0; border-radius:0; }
.dshpm-thread { position:relative; display:flex; flex:1; min-height:0; }
.dshpm-simple .dshpm-messages { flex:1; min-height:0; max-height:none; padding:24px 12px 16px; overscroll-behavior:contain; overflow-anchor:none; }
.dshpm-simple .dshpm-message { background:transparent; padding:6px 0; margin:0 0 24px; }
.dshpm-simple .dshpm-message-user { margin-left:auto; max-width:85%; width:fit-content; border-radius:18px 18px 4px 18px; background:var(--dsw-alias-bg-layer-2); padding:12px 18px; }
.dshpm-simple .dshpm-message > strong { display:block; margin-bottom:8px; }
.dshpm-simple .dshpm-summary { border:0; padding:0; }
.dshpm-simple .dshpm-actionCard { margin:8px 0 16px; padding:16px 20px; max-width:none; background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 3%,var(--dsw-alias-bg-layer-1)); border-radius:14px; }
.dshpm-simple .dshpm-actionCard h2 { font-size:17px; margin:8px 0; }
.dshpm-simple .dshpm-actionCard > p { margin:6px 0; }
.dshpm-simple .dshpm-question { background:transparent; border:0; padding:0 !important; font-weight:400; }
.dshpm-simple .dshpm-composer { flex:none; margin:0; padding:12px 16px; border:1px solid var(--dsw-alias-border-l1); border-radius:20px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 4px 20px #15254b08; }
.dshpm-simple .dshpm-composer label { margin:0; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dshpm-simple .dshpm-composer textarea { width:100%; min-height:64px; max-height:160px; border:0; background:transparent; padding:8px 0; box-shadow:none; resize:vertical; color:var(--dsw-alias-label-primary); }
.dshpm-simple .dshpm-composer .dshpm-actions { justify-content:flex-end; }
.dshpm-starters { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
.dshpm-starters .dshwb-btn { border-radius:99px; background:transparent; font-weight:400; font-size:12px; }
.dshpm-latest { position:absolute; bottom:12px; left:50%; transform:translateX(-50%); border-radius:99px; box-shadow:0 2px 10px #0002; }
.dshpm-simple .dshpm-welcome { overflow:auto; flex:1; width:100%; max-width:780px; margin:0 auto; padding:clamp(24px,8vh,80px) 12px 24px; border:0; border-radius:0; background:transparent; }
.dshpm-welcome h2 { font-size:26px; margin:12px 0 24px; }
.dshpm-welcome .dshpm-nameOption { margin:16px 0; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dshpm-welcome summary { cursor:pointer; }
.dshpm-welcome textarea { padding:18px; border-radius:18px; min-height:140px; }
.dshpm-welcome .dshpm-ideaEcho { margin-left:auto; width:fit-content; max-width:90%; padding:12px 18px; background:var(--dsw-alias-bg-layer-2); border-radius:18px; overflow-wrap:anywhere; }
.dshpm-simple .dshpm-welcome .dshpm-goals { grid-template-columns:1fr; gap:8px; }
.dshpm-simple .dshpm-welcome .dshpm-goals button { min-height:0; padding:12px 16px; }
.dshpm-simple .dshpm-welcome .dshpm-goals button span { margin-top:2px; }
@media(max-width:600px) {
 .dshpm-simple { padding:10px 12px max(10px,env(safe-area-inset-bottom)); }
 .dshpm-simple .dshpm-header { align-items:flex-start; flex-wrap:wrap; padding-bottom:8px; gap:8px; }
 .dshpm-simple .dshpm-header .dshpm-actions { gap:6px; }
 .dshpm-simple .dshpm-header h1 { font-size:17px; }
 .dshpm-simple .dshpm-header .dshwb-hint { max-width:100%; overflow-wrap:anywhere; }
 .dshpm-simple .dshpm-messages { padding:14px 0 8px; }
 .dshpm-simple .dshpm-composer { padding:10px 12px; border-radius:16px; }
 .dshpm-simple .dshpm-composer textarea { min-height:48px; }
 .dshpm-welcome h2 { font-size:23px; }
 .dshpm-simple .dshpm-welcome { padding-top:24px; }
 .dshpm-starters .dshwb-btn { min-height:36px; }
}

.dshpm-simple .dshpm-actionCard { border:0; border-left:2px solid var(--dsw-alias-border-l1); border-radius:0; background:transparent; padding:4px 0 4px 18px; }
.dshpm-customAnswer > summary { cursor:pointer; font-size:13px; color:var(--dsw-alias-label-secondary); padding:8px 0; }
.dshpm-simple .dshpm-question .dshpm-actions .dshwb-btn { border-radius:99px; }
`;

    /* ------------------------------------------------------------------
     * Plugin registration
     * ---------------------------------------------------------------- */

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'sessions', 'layout'],
      __test: { ManagerLearning, ManagerThread, managerBlocks, MessageMarkdown, ManagerMessage, Button, useToast, disabledToastListeners, supportsManagerPresentation, ManagerActionCard, ManagerResultsSheet, managerApprovalReason, ManagerSetup, managerModePreference },

      apply(ctx) {
        const localeRuntime = ctx.locale;
        const copyNow = () => copyFor(localeRuntime.getLocale().active);

        /**
         * Send one prompt into the project's persistent workbench Session.
         * Creates the Session on first use. A stale Session id is recovered by
         * creating a fresh one rather than losing the prompt.
         */
        /**
         * Create the Session that owns one stage, with that stage's agent preset.
         * A profile without the preset still works: creation falls back to the
         * default agent instead of failing the stage.
         */
        const createSession = async (stage) => {
          const meta = workbenchStore.getMeta();
          if (!meta.projectRoot) throw new Error('请先选择独立的业务项目目录，再启动任务。');
          const base = { cwd: meta.projectRoot };
          const preset = STAGE_PRESETS[stage];
          let id;
          try {
            id = await ctx.sessions.create(preset ? { ...base, agentPreset: preset } : base);
          } catch (error) {
            id = await ctx.sessions.create(base);
          }
          workbenchStore.setStageSession(stage, id);
          return id;
        };

        const sendTo = async (id, text, mode, justCreated, stage) => {
          await ctx.sessions.using(id, { source: 'dsh-workbench' }, async (reference) => {
            await reference.ready;
            {
              const name = requirementName(workbenchStore.get());
              const prefix = copyNow().stage[stage] ? copyNow().stage[stage].short : '工作台';
              await reference.binding.session.rename(`${name} · ${prefix}`.slice(0, 180)).catch(() => {});
            }
            const result = await reference.binding.session.prompt([{ type: 'text', text }], mode);
            if (!result.ok) {
              const message =
                (result.error && (result.error.message || result.error.code)) || 'prompt was rejected';
              throw new Error(String(message));
            }
          });
        };

        const sendPrompt = async (text, options = {}) => {
          const state = workbenchStore.get();
          const stage = STAGES.includes(options.stage) ? options.stage : state.stage;
          const mode = options.mode === 'steer' ? 'steer' : 'queue';
          let id = sessionFor(state, stage);
          let created = false;
          if (!id) {
            id = await createSession(stage);
            created = true;
          }
          try {
            await sendTo(id, text, mode, created, stage);
          } catch (error) {
            if (!created) {
              id = await createSession(stage);
              await sendTo(id, text, mode, true, stage);
            } else {
              throw error;
            }
          }
          // Stay in the workbench: the dock hosts the live conversation, so a
          // prompt never navigates the whole page to another panel.
          return id;
        };

        const openSession = (sessionId) => {
          if (!sessionId) return;
          ctx.uiWorkspace.openSession(sessionId);
        };

        const retainSession = (sessionId) => ctx.sessions.retain(sessionId, { source: 'dsh-workbench' });

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              children: { 'workbench.chat': { kind: 'single', scope: 'session' } },
              inject: () => ({
                localeRuntime,
                sendPrompt,
                openSession,
                retainSession,
                pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
              }),
            },
            WorkbenchPage,
          ),
        );

        ctx.slots.inject('workbench.chat', () =>
          ctx.slots.register({ name: 'workbench.chat' }, WorkbenchChat),
        );

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => copyNow().panel,
            },
            WorkbenchIcon,
          ),
        );

        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: PANEL_ID,
              order: 40,
              label: () => copyNow().panel,
              inject: () => ({
                localeRuntime,
                openSession,
                openFullWorkbench: () => ctx.layout.selectPanel(PANEL_ID),
                startStage: async (stage) => {
                  const state = workbenchStore.get();
                  if (isLocked(state, stage)) return;
                  workbenchStore.invalidateFrom(stage);
                  try {
                    const prompt = buildStagePrompt(state, stage);
                    await sendContextPrompt(sendPrompt, prompt, { stage });
                    workbenchStore.patchStage(stage, { startedAt: new Date().toISOString() });
                    workbenchStore.addActivity(`${copyNow().stage[stage].title} · ${copyNow().action.start}`, 'prompt');
                  } catch (error) {
                    // The full page owns visible error reporting; this compact
                    // surface intentionally stays quiet on failure.
                    console.warn('workbench stage start failed:', error);
                  }
                },
              }),
            },
            WorkbenchView,
          ),
        );
      },
    };

    /** Sidebar icon; the sidebar owns the button and selected state. */
    function WorkbenchIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: edge,
          height: edge,
          fill: 'currentColor',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('rect', { x: 1, y: 9, width: 2, height: 4, rx: 1 }),
        h('rect', { x: 4, y: 7, width: 2, height: 6, rx: 1 }),
        h('rect', { x: 7, y: 5, width: 2, height: 8, rx: 1 }),
        h('rect', { x: 10, y: 3, width: 2, height: 10, rx: 1 }),
        h('rect', { x: 13, y: 1, width: 2, height: 12, rx: 1 }),
      );
    }
  },
});
