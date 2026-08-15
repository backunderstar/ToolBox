import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  projectsArchive,
  projectsCreate,
  projectsDelete,
  projectsFiles,
  projectsList,
  projectsOpen,
  projectsUnarchive,
} from "./api";
import type { ProjectFile, ProjectInfo } from "./api";
import { useVault } from "./vault";

/**
 * 项目文件管理（M8）
 *
 * - 项目 = vault/projects/ 下的普通文件夹（无元数据），归档 = 移动到 archive/
 * - 列表与文件浏览均直接读写文件系统（文件为唯一真源），不做本地副本
 * - 打开文件/文件夹走 Rust `projects_open`（系统默认应用 / 资源管理器）
 */

interface ProjectContextValue {
  projects: ProjectInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<void>;
  archive: (name: string) => Promise<void>;
  unarchive: (name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  // 详情页（文件浏览器）
  current: string | null;
  cwd: string; // 当前目录（相对项目根，"" = 根）
  files: ProjectFile[] | null;
  fileLoading: boolean;
  openProject: (name: string) => Promise<void>;
  closeProject: () => void;
  enterDir: (dir: string) => Promise<void>;
  backDir: () => void;
  openFile: (rel: string) => Promise<void>;
  openFolder: (rel: string) => Promise<void>;
  notice: string | null;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjects(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjects 必须在 ProjectsProvider 内使用");
  return ctx;
}

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const vaultPath = vault.path;
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  }, []);

  const refresh = useCallback(async () => {
    if (!vaultPath) {
      setProjects([]);
      return;
    }
    setLoading(true);
    try {
      setProjects(await projectsList(vaultPath));
    } catch (e) {
      flash(String(e));
    } finally {
      setLoading(false);
    }
  }, [vaultPath, flash]);

  const create = useCallback(
    async (name: string) => {
      if (!vaultPath) return;
      try {
        await projectsCreate(vaultPath, name.trim());
        await refresh();
        flash(`已创建项目 ${name.trim()}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [vaultPath, refresh, flash]
  );

  const archive = useCallback(
    async (name: string) => {
      if (!vaultPath) return;
      try {
        await projectsArchive(vaultPath, name);
        if (current === name) closeProjectRef.current();
        await refresh();
        flash(`已归档 ${name}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [vaultPath, refresh, flash, current]
  );

  const unarchive = useCallback(
    async (name: string) => {
      if (!vaultPath) return;
      try {
        await projectsUnarchive(vaultPath, name);
        await refresh();
        flash(`已还原 ${name}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [vaultPath, refresh, flash]
  );

  const remove = useCallback(
    async (name: string) => {
      if (!vaultPath) return;
      try {
        await projectsDelete(vaultPath, name);
        if (current === name) closeProjectRef.current();
        await refresh();
        flash(`已删除 ${name}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [vaultPath, refresh, flash, current]
  );

  const closeProject = useCallback(() => {
    setCurrent(null);
    setCwd("");
    setFiles(null);
  }, []);

  // 供 archive/remove 闭包稳定调用（避免循环依赖 useCallback）
  const closeProjectRef = useRef(closeProject);
  closeProjectRef.current = closeProject;

  /** 加载 current 项目 cwd 目录的文件列表 */
  const loadFiles = useCallback(async () => {
    if (!vaultPath || !current) {
      setFiles(null);
      return;
    }
    setFileLoading(true);
    try {
      setFiles(await projectsFiles(vaultPath, current, cwd));
    } catch (e) {
      setFiles(null);
      flash(String(e));
    } finally {
      setFileLoading(false);
    }
  }, [vaultPath, current, cwd, flash]);

  const openProject = useCallback(
    async (name: string) => {
      setCurrent(name);
      setCwd("");
      // 进入详情页后由 cwd 变化触发 loadFiles
    },
    []
  );

  const enterDir = useCallback(
    async (dir: string) => {
      // dir 是相对项目根的完整路径（来自文件列表行的 path 字段）
      setCwd(dir);
    },
    []
  );

  const backDir = useCallback(() => {
    setCwd((prev) => {
      const idx = prev.lastIndexOf("/");
      return idx === -1 ? "" : prev.slice(0, idx);
    });
  }, []);

  const openFile = useCallback(
    async (rel: string) => {
      if (!vaultPath || !current) return;
      try {
        await projectsOpen(vaultPath, current, rel);
        flash(`已用默认应用打开 ${rel.split("/").pop()}`);
      } catch (e) {
        flash(String(e));
        void loadFiles();
      }
    },
    [vaultPath, current, flash, loadFiles]
  );

  const openFolder = useCallback(
    async (rel: string) => {
      if (!vaultPath || !current) return;
      try {
        await projectsOpen(vaultPath, current, rel);
        flash(`已打开文件夹 ${rel || "(项目根)"}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [vaultPath, current, flash]
  );

  /* 工作区切换 / 首次进入时刷新列表 */
  useEffect(() => {
    void refresh();
  }, [refresh, vaultPath]);

  /* 进入项目 / 目录变化时加载文件列表 */
  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      loading,
      refresh,
      create,
      archive,
      unarchive,
      remove,
      current,
      cwd,
      files,
      fileLoading,
      openProject,
      closeProject,
      enterDir,
      backDir,
      openFile,
      openFolder,
      notice,
    }),
    [
      projects,
      loading,
      refresh,
      create,
      archive,
      unarchive,
      remove,
      current,
      cwd,
      files,
      fileLoading,
      openProject,
      closeProject,
      enterDir,
      backDir,
      openFile,
      openFolder,
      notice,
    ]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
