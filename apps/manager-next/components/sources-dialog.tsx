"use client";
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { useWorkspace } from "./workspace-provider";
import { Modal } from "./modal";
import { errorText } from "../lib/api-client";
import type { Source, SourceCandidate } from "../lib/contracts";
export function SourcesDialog({
  projectId,
  onClose,
  onLearn,
  purpose = "learning",
  onModify,
}: {
  projectId: string;
  onClose: () => void;
  onLearn: (hasSources: boolean) => void;
  purpose?: "learning" | "modify";
  onModify?: () => void;
}) {
  const previewEpoch = useRef(0);
  useEffect(
    () => () => {
      previewEpoch.current++;
    },
    [],
  );
  const { api, notice } = useWorkspace(),
    [files, setFiles] = useState<Source[]>([]),
    [candidates, setCandidates] = useState<SourceCandidate[]>([]),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [consent, setConsent] = useState(false),
    [editable, setEditable] = useState(false),
    [imported, setImported] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function load() {
    const data = await api<{ files: Source[] }>(
      "GET",
      `/api/v1/projects/${projectId}/sources`,
    );
    setFiles(data.files);
  }
  useEffect(() => {
    void load().catch((e) => setMessage(errorText(e)));
  }, [projectId]);
  async function preview(list: FileList | null) {
    const generation = ++previewEpoch.current;
    setConsent(false);
    const next: SourceCandidate[] = [];
    for (const file of Array.from(list || []).slice(0, 500)) {
      const path = file.webkitRelativePath || file.name;
      if (
        file.size > 32768 ||
        !/\.(md|markdown|txt|rst|py|js|mjs|cjs|ts|tsx|jsx|json|html|css|scss|vue|svelte|go|rs|java|c|h|cpp|sql|sh|yaml|yml|toml)$/i.test(
          path,
        ) ||
        path
          .split("/")
          .some(
            (p) =>
              p.startsWith(".") ||
              /^(node_modules|vendor|dist|build|venv|__pycache__|coverage)$/i.test(
                p,
              ),
          )
      )
        continue;
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (content.includes("\0")) continue;
        next.push({ path, content });
      } catch {}
      if (next.length === 50) break;
    }
    if (generation !== previewEpoch.current) return;
    setConsent(false);
    setCandidates(next);
    setSelected(new Set(next.map((x) => x.path)));
    setMessage(
      `可选 ${next.length} 份，跳过或未展示 ${(list?.length || 0) - next.length} 份。请检查是否含敏感资料。`,
    );
  }
  async function upload() {
    if (busy) return;
    if (!consent) {
      setMessage("请先检查清单并勾选上传授权。");
      return;
    }
    const chosen = candidates.filter((f) => selected.has(f.path));
    if (!chosen.length) {
      setMessage("请至少勾选一份资料。");
      return;
    }
    setBusy(true);
    let count = 0;
    try {
      for (const file of chosen) {
        await api("POST", `/api/v1/projects/${projectId}/sources`, {
          files: [file],
        });
        count++;
      }
      setCandidates([]);
      setImported(false);
      setConsent(false);
      setMessage(`已上传 ${count} 份只读资料，尚未调用模型。`);
    } catch (e) {
      setMessage(
        `已上传 ${count} 份，其余未确认：${errorText(e)}。请核对已有资料。`,
      );
    } finally {
      setBusy(false);
      try {
        await load();
      } catch (e) {
        notice(errorText(e));
      }
    }
  }
  return (
    <Modal
      title={purpose === "modify" ? "选择要修改的已有项目" : "项目资料与学习"}
      onClose={onClose}
      busy={busy}
    >
      <p className="muted">
        选择已有项目的文字资料，管家才能根据文件讲解。仅上传你勾选并授权的只读副本，不会运行本地项目。
      </p>
      <div className="source-picker">
        <label className="button">
          选择项目文件夹
          <input
            type="file"
            multiple
            {...({
              webkitdirectory: "",
              directory: "",
            } as InputHTMLAttributes<HTMLInputElement>)}
            onChange={(e) => void preview(e.target.files)}
          />
        </label>
        <label className="button">
          选择多个文件
          <input
            type="file"
            multiple
            onChange={(e) => void preview(e.target.files)}
          />
        </label>
      </div>
      <small>
        每文件最多 32KiB，项目最多 50 份 /
        512KiB。请勿选择密钥、密码或生产数据。
      </small>
      {candidates.length > 0 && (
        <>
          <ul className="source-candidates">
            {candidates.map((f) => (
              <li key={f.path}>
                <label className="question-option">
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={(e) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        if (e.target.checked) next.add(f.path);
                        else next.delete(f.path);
                        return next;
                      })
                    }
                  />
                  {f.path}
                </label>
              </li>
            ))}
          </ul>
          <label className="question-option">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked);
                setMessage("");
              }}
            />
            我已检查资料，授权上传选中文件；后续提问可将相关摘录发送给模型。
          </label>
          <button
            className="primary"
            onClick={() => void upload()}
            disabled={busy}
          >
            上传选中的资料
          </button>
        </>
      )}
      <p role="status">{message}</p>
      <h3>已关联资料 · {files.length}</h3>
      <ul className="artifact-list">
        {files.map((f) => (
          <li key={f.path}>
            <span>
              {f.path}
              <small>{f.bytes} 字节</small>
            </span>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("DELETE", `/api/v1/projects/${projectId}/sources`, {
                    path: f.path,
                  });
                  await load();
                } catch (e) {
                  setMessage(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      {!files.length && (
        <p className="muted">
          尚未关联资料。你也可以先让管家询问需要哪些文件。
        </p>
      )}
      {purpose === "modify" && files.length > 0 && (
        <div className="import-workspace">
          <p>
            如需实际修改，将以上已上传文件复制到服务器的独立工作区
            imported-project。保留原目录层级，不修改你电脑中的原项目；这是筛选后的文字文件副本，可能缺少依赖和二进制资源。
          </p>
          <label className="question-option">
            <input
              type="checkbox"
              checked={editable}
              onChange={(e) => setEditable(e.target.checked)}
            />
            我授权创建可修改的服务器项目副本
          </label>
          <button
            disabled={busy || !editable || imported}
            onClick={async () => {
              setBusy(true);
              try {
                await api(
                  "POST",
                  `/api/v1/projects/${projectId}/sources/import-workspace`,
                  {
                    consent: editable,
                    files: files.map((f) => ({
                      path: f.path,
                      sha256: f.sha256,
                    })),
                  },
                );
                setImported(true);
                setMessage("已导入可修改副本；尚未执行代码或调用模型。");
              } catch (e) {
                setMessage(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {imported ? "副本已导入" : "导入为可修改副本"}
          </button>
        </div>
      )}
      <button
        className="primary"
        disabled={busy}
        onClick={() =>
          purpose === "modify" ? onModify?.() : onLearn(files.length > 0)
        }
      >
        {purpose === "modify" ? "继续描述修改需求" : "带我学懂这个项目"}
      </button>
      <small>只准备可编辑的提问草稿，点击发送后才调用模型。</small>
    </Modal>
  );
}
