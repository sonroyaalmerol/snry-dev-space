import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, complete } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  readdir,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "pi-job-search",
);
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "pi-job-search",
);

const SOURCE_TTL: Record<string, number> = {
  jobapi: 30 * 60 * 1000,
  remotive: 45 * 60 * 1000,
  greenhouse: 2 * 3600 * 1000,
  resume: 24 * 3600 * 1000,
  linkedin_apply: 2 * 3600 * 1000,
  linkedin_profile: 24 * 3600 * 1000,
  enrich: 6 * 3600 * 1000,
};

const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;

interface Config {
  linkedin?: {
    li_at: string;
    jsessionid?: string;
    bcookie?: string;
  };
}

let cachedConfig: Config | null = null;

async function loadConfig(): Promise<Config> {
  if (cachedConfig) return cachedConfig;
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, "utf8");
      cachedConfig = JSON.parse(raw) as Config;
      return cachedConfig!;
    }
  } catch {}
  return {};
}

async function saveConfig(config: Config): Promise<void> {
  try {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true });
    }
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    cachedConfig = config;
  } catch {}
}

async function ensureConfigExists(): Promise<void> {
  if (existsSync(CONFIG_PATH)) return;
  await saveConfig({
    linkedin: {
      li_at: "",
      jsessionid: "",
      bcookie: "",
    },
  });
}

interface CacheEntry {
  key: string;
  timestamp: number;
  ttl: number;
  data: string;
}

function cacheKey(namespace: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
    .join("&");
  const hash = createHash("sha256")
    .update(`${namespace}:${sorted}`)
    .digest("hex")
    .slice(0, 16);
  return `${namespace}-${hash}.json`;
}

function entryPath(filename: string): string {
  return join(CACHE_DIR, filename);
}

async function ensureCacheDir(): Promise<void> {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

async function readCache(
  namespace: string,
  params: Record<string, unknown>,
): Promise<string | null> {
  try {
    const filename = cacheKey(namespace, params);
    const path = entryPath(filename);
    if (!existsSync(path)) return null;

    const raw = await readFile(path, "utf8");
    const entry: CacheEntry = JSON.parse(raw);

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      unlink(path).catch(() => {});
      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

async function writeCache(
  namespace: string,
  params: Record<string, unknown>,
  data: string,
): Promise<void> {
  try {
    await ensureCacheDir();
    const filename = cacheKey(namespace, params);
    const path = entryPath(filename);
    const tmpPath = join(
      tmpdir(),
      `pi-job-cache-${process.pid}-${Date.now()}.tmp`,
    );

    const entry: CacheEntry = {
      key: filename,
      timestamp: Date.now(),
      ttl: SOURCE_TTL[namespace] ?? 30 * 60 * 1000,
      data,
    };

    await writeFile(tmpPath, JSON.stringify(entry), "utf8");
    await rename(tmpPath, path);

    evictIfNeeded().catch(() => {});
  } catch {}
}

async function readCacheStale(
  namespace: string,
  params: Record<string, unknown>,
): Promise<string | null> {
  try {
    const filename = cacheKey(namespace, params);
    const path = entryPath(filename);
    if (!existsSync(path)) return null;

    const raw = await readFile(path, "utf8");
    const entry: CacheEntry = JSON.parse(raw);
    return entry.data;
  } catch {
    return null;
  }
}

async function evictIfNeeded(): Promise<void> {
  try {
    if (!existsSync(CACHE_DIR)) return;
    const files = await readdir(CACHE_DIR);
    if (files.length <= MAX_CACHE_ENTRIES) return;

    const entries: {
      name: string;
      path: string;
      mtime: number;
      size: number;
    }[] = [];
    let totalSize = 0;

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const p = entryPath(f);
      try {
        const s = await stat(p);
        entries.push({
          name: f,
          path: p,
          mtime: s.mtimeMs,
          size: s.size,
        });
        totalSize += s.size;
      } catch {}
    }

    const overCount = entries.length - MAX_CACHE_ENTRIES;
    const overSize = totalSize - MAX_CACHE_BYTES;
    if (overCount <= 0 && overSize <= 0) return;

    entries.sort((a, b) => a.mtime - b.mtime);

    let evicted = 0;
    let freed = 0;
    const targetEvict =
      Math.max(overCount, 0) + Math.ceil(entries.length * 0.1);

    for (const e of entries) {
      if (evicted >= targetEvict && freed >= overSize) break;
      try {
        await unlink(e.path);
        evicted++;
        freed += e.size;
      } catch {}
    }
  } catch {}
}

function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function decodeLinkedInSafetyUrl(url: string): string {
  try {
    if (!url.includes("linkedin.com/safety/go")) return url;
    const u = new URL(url);
    const target = u.searchParams.get("url");
    return target ? decodeURIComponent(target) : url;
  } catch {
    return url;
  }
}

interface LinkedInApplyInfo {
  companyApplyUrl?: string;
  easyApplyUrl?: string;
  methodType?: string;
}

async function resolveLinkedInApplyUrl(
  jobId: string,
  config: NonNullable<Config["linkedin"]>,
  signal?: AbortSignal,
): Promise<LinkedInApplyInfo | null> {
  const cached = await readCache("linkedin_apply", { id: jobId });
  if (cached) {
    try {
      return JSON.parse(cached) as LinkedInApplyInfo;
    } catch {}
  }

  const cookieParts = [`li_at=${config.li_at}`];
  if (config.bcookie) cookieParts.push(`bcookie="${config.bcookie}"`);
  if (config.jsessionid) cookieParts.push(`JSESSIONID="${config.jsessionid}"`);

  const headers: Record<string, string> = {
    cookie: cookieParts.join("; "),
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  };
  if (config.jsessionid) {
    headers["csrf-token"] = config.jsessionid;
  }

  const url = `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}`;

  try {
    const res = await fetch(url, { signal, headers });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      data?: {
        applyMethod?: {
          companyApplyUrl?: string;
          easyApplyUrl?: string;
          $type?: string;
        };
      };
    };

    const applyMethod = data.data?.applyMethod;
    if (!applyMethod) return null;

    const info: LinkedInApplyInfo = {
      companyApplyUrl: applyMethod.companyApplyUrl
        ? decodeLinkedInSafetyUrl(applyMethod.companyApplyUrl)
        : undefined,
      easyApplyUrl: applyMethod.easyApplyUrl
        ? decodeLinkedInSafetyUrl(applyMethod.easyApplyUrl)
        : undefined,
      methodType: applyMethod.$type?.split(".").pop(),
    };

    await writeCache("linkedin_apply", { id: jobId }, JSON.stringify(info));

    return info;
  } catch {
    return null;
  }
}

interface ApplyField {
  name: string;
  type: string;
  required: boolean;
  label?: string;
  options?: string[];
}

interface ApplyInfo {
  platform: string;
  fields: ApplyField[];
  notes?: string;
}

interface Job {
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl?: string;
  applyInfo?: ApplyInfo;
  description?: string;
  salary?: string;
  jobType?: string;
  isRemote?: boolean;
  datePosted?: string;
  site: string;
  matchScore?: number;
  matchReason?: string;
}

const JOB_API = "https://j0b-api.vercel.app";

const jobApiSites = ["indeed", "linkedin", "remoteok", "remotive"] as const;
type JobApiSite = (typeof jobApiSites)[number];

const allPlatforms = [...jobApiSites, "greenhouse"] as const;

const workModes = ["remote", "hybrid", "onsite"] as const;

const SearchParams = Type.Object({
  query: Type.String({
    description: "Job search keywords, e.g. 'software engineer'",
  }),
  location: Type.Optional(
    Type.String({ description: "City, state, country, or 'remote'" }),
  ),
  sites: Type.Optional(
    Type.Array(StringEnum([...allPlatforms] as const), {
      description:
        "Platforms to search. Default: all. Options: indeed, linkedin, remoteok, remotive, greenhouse",
      default: [...allPlatforms],
    }),
  ),
  job_type: Type.Optional(
    StringEnum(["fulltime", "parttime", "contract", "internship"] as const, {
      description: "Employment type filter",
    }),
  ),
  work_mode: Type.Optional(
    StringEnum(workModes, {
      description: "Work arrangement filter: remote, hybrid, or onsite",
    }),
  ),
  is_remote: Type.Optional(
    Type.Boolean({
      description: "Set true for remote-only, false for onsite-only",
    }),
  ),
  results_wanted: Type.Optional(
    Type.Number({
      description: "Max results per platform (default 15, max 50)",
      default: 15,
    }),
  ),
  hours_old: Type.Optional(
    Type.Number({ description: "Only jobs posted within the last N hours" }),
  ),
  company: Type.Optional(
    Type.String({
      description:
        "Target company name. Used for Greenhouse ATS to find jobs at a specific company",
    }),
  ),
  distance: Type.Optional(
    Type.Number({
      description: "Search radius in miles (default 50, for Indeed/LinkedIn)",
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "Path to a resume file (.txt, .md, or .pdf) to score and rank jobs by relevance to your experience",
    }),
  ),
  linkedin_profile: Type.Optional(
    Type.String({
      description:
        "LinkedIn profile URL (e.g. https://www.linkedin.com/in/username) to use as basis for scoring and resume generation. Requires li_at cookie in config. Falls back to resume parameter if both provided.",
    }),
  ),
  min_match_score: Type.Optional(
    Type.Number({
      description:
        "Minimum match score (0-100) when using resume scoring. Jobs below this are filtered out.",
    }),
  ),
  generate_resumes: Type.Optional(
    Type.Boolean({
      description:
        "Generate a targeted resume (.md and .pdf) for each matched job. Requires resume parameter. Only real experience is used -- nothing is fabricated.",
      default: false,
    }),
  ),
  resume_output_dir: Type.Optional(
    Type.String({
      description:
        "Directory to save generated resumes. Default: ~/job-resumes/",
    }),
  ),
  max_resumes: Type.Optional(
    Type.Number({
      description:
        "Max number of targeted resumes to generate (default 10, max 20)",
      default: 10,
    }),
  ),
  open_apply_urls: Type.Optional(
    Type.Boolean({
      description:
        "Open all found apply URLs in the default browser -- each as a tab in a new window.",
      default: false,
    }),
  ),
});

function fmtSalary(job: any): string | undefined {
  if (job.salary) {
    if (typeof job.salary === "string") return job.salary;
    const s = job.salary;
    if (s.min_amount && s.max_amount) {
      const interval = s.interval
        ? `/${s.interval.replace("yearly", "year").replace("monthly", "month").replace("hourly", "hour")}`
        : "";
      return `${s.currency ?? "$"}${s.min_amount}-${s.max_amount}${interval}`;
    }
  }
  if (job.min_amount || job.max_amount) {
    const interval = job.interval
      ? `/${job.interval.replace("yearly", "year").replace("monthly", "month").replace("hourly", "hour")}`
      : "";
    return `${job.currency ?? "$"}${job.min_amount ?? "?"}-${job.max_amount ?? "?"}${interval}`;
  }
  return undefined;
}

function fmtDate(d?: string | number): string | undefined {
  if (!d) return undefined;
  try {
    const ms = typeof d === "number" ? d * 1000 : d;
    return new Date(ms).toISOString().split("T")[0];
  } catch {
    return undefined;
  }
}

function fmtApplyUrl(job: Job): string | undefined {
  if (!job.applyUrl) return undefined;
  if (job.applyUrl === job.url || job.applyUrl === `${job.url}/`)
    return undefined;
  return job.applyUrl;
}

function fmtApplyInfo(job: Job): string | undefined {
  if (!job.applyInfo) return undefined;
  const info = job.applyInfo;
  const parts: string[] = [];
  parts.push(`   📝 Apply via ${info.platform}`);
  if (info.notes) parts.push(`   ${info.notes}`);
  for (const f of info.fields) {
    const req = f.required ? "*" : "";
    const label = f.label ?? f.name;
    const type =
      f.type === "file"
        ? " (file upload)"
        : f.type === "select" && f.options?.length
          ? ` (options: ${f.options.slice(0, 5).join(", ")})`
          : "";
    parts.push(`   - ${label}${req}${type}`);
  }
  return parts.join("\n");
}

function fmtJobs(jobs: Job[]): string {
  if (jobs.length === 0) return "No jobs found matching the criteria.";

  const lines: string[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const parts: string[] = [];

    const scoreTag =
      j.matchScore !== undefined ? ` [${j.matchScore}% match]` : "";
    parts.push(`${i + 1}. **${j.title}** at **${j.company}**${scoreTag}`);

    const meta: string[] = [];
    if (j.location) meta.push(`📍 ${j.location}`);
    if (j.salary) meta.push(`💰 ${j.salary}`);
    if (j.jobType) meta.push(`📋 ${j.jobType}`);
    if (j.isRemote) meta.push("🏠 Remote");
    if (j.datePosted) meta.push(`📅 ${j.datePosted}`);
    if (j.site) meta.push(`🔗 ${j.site}`);
    if (meta.length > 0) parts.push("   " + meta.join(" | "));

    const apply = fmtApplyUrl(j);
    if (apply) {
      parts.push(`   🔗 Listing: ${j.url}`);
      parts.push(`   ✅ Apply: ${apply}`);
    } else {
      parts.push(`   ${j.url}`);
    }

    if (j.matchReason) {
      parts.push(`   **Why this matches:** ${j.matchReason}`);
    }

    const applyInfoStr = fmtApplyInfo(j);
    if (applyInfoStr) parts.push(applyInfoStr);

    if (j.description) {
      const desc = j.description.replace(/\n{3,}/g, "\n\n").trim();
      const snippet = desc.length > 300 ? desc.slice(0, 300) + "…" : desc;
      parts.push(`   > ${snippet.replace(/\n/g, "\n   > ")}`);
    }

    lines.push(parts.join("\n"));
  }

  return lines.join("\n\n");
}

async function readResumeFile(filePath: string): Promise<string> {
  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "pdf") {
    try {
      const { stdout } = await execFileAsync("pdftotext", [
        "-layout",
        filePath,
        "-",
      ]);
      return stdout.trim();
    } catch {
      throw new Error(
        "Failed to parse PDF. Ensure pdftotext is installed (poppler-utils).",
      );
    }
  }
  return (await readFile(filePath, "utf8")).trim();
}

async function scoreJobsAgainstResume(
  jobs: Job[],
  resumeText: string,
  model: Model<Api>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Job[]> {
  if (jobs.length === 0) return jobs;

  const resumeHash = hashString(resumeText.slice(0, 2000));
  const modelId = model.id;
  const uncached: { idx: number; job: Job }[] = [];
  const results: { idx: number; score?: number; reason?: string }[] = [];

  for (let i = 0; i < jobs.length; i++) {
    const cached = await readCache("resume", {
      rh: resumeHash,
      model: modelId,
      url: jobs[i].url,
      title: jobs[i].title,
    });
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        results.push({
          idx: i,
          score: parsed.score,
          reason: parsed.reason,
        });
      } catch {
        uncached.push({ idx: i, job: jobs[i] });
      }
    } else {
      uncached.push({ idx: i, job: jobs[i] });
    }
  }

  if (uncached.length > 0) {
    const batchSize = 10;
    for (let bi = 0; bi < uncached.length; bi += batchSize) {
      if (signal?.aborted) break;

      const batch = uncached.slice(bi, bi + batchSize);
      const jobList = batch
        .map(
          ({ job }, idx) =>
            `JOB ${bi + idx + 1}:\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n${job.description ? `Description: ${job.description.slice(0, 500)}` : "Description: N/A"}`,
        )
        .join("\n\n");

      const prompt = `You are a job-resume matching expert. Score each job's relevance to the candidate's resume on a 0-100 scale. Also provide a brief one-line reason for the score.

RESUME:
${resumeText.slice(0, 3000)}

${jobList}

Respond ONLY with valid JSON matching this exact schema:
{"scores": [{"index": number, "score": number, "reason": string}]}

Where index is the 1-based job number from the list above.`;

      try {
        const result = await complete(
          model,
          {
            systemPrompt:
              "You respond only in valid JSON. No markdown, no code fences.",
            messages: [
              {
                role: "user",
                content: prompt,
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey, signal, maxTokens: 1024 },
        );

        const text = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");

        const jsonStr = text
          .replace(/```json?\n?/g, "")
          .replace(/```/g, "")
          .trim();
        const parsed = JSON.parse(jsonStr) as {
          scores: {
            index: number;
            score: number;
            reason: string;
          }[];
        };

        const scoreMap = new Map(parsed.scores.map((s) => [s.index, s]));

        for (let j = 0; j < batch.length; j++) {
          const jobIdx = bi + j + 1;
          const s = scoreMap.get(jobIdx);
          const score = s ? Math.max(0, Math.min(100, s.score)) : undefined;
          const reason = s?.reason;

          results.push({ idx: batch[j].idx, score, reason });

          if (score !== undefined) {
            await writeCache(
              "resume",
              {
                rh: resumeHash,
                model: modelId,
                url: batch[j].job.url,
                title: batch[j].job.title,
              },
              JSON.stringify({ score, reason }),
            );
          }
        }
      } catch {
        for (const b of batch) {
          results.push({ idx: b.idx });
        }
      }
    }
  }

  for (const r of results) {
    if (r.score !== undefined) {
      jobs[r.idx].matchScore = r.score;
      jobs[r.idx].matchReason = r.reason;
    }
  }

  return jobs;
}

async function fetchJobApi(
  sites: JobApiSite[],
  params: {
    query: string;
    location?: string;
    job_type?: string;
    is_remote?: boolean;
    results_wanted?: number;
    hours_old?: number;
    distance?: number;
  },
  signal?: AbortSignal,
): Promise<Job[]> {
  const cacheParams: Record<string, unknown> = {
    sites: sites.sort().join(","),
    query: params.query,
    location: params.location ?? "",
    job_type: params.job_type ?? "",
    is_remote: params.is_remote,
    results_wanted: params.results_wanted,
    distance: params.distance,
  };

  const cached = await readCache("jobapi", cacheParams);
  if (cached) {
    try {
      return JSON.parse(cached) as Job[];
    } catch {}
  }

  const url = new URL(`${JOB_API}/api/jobs`);
  url.searchParams.set("site_name", sites.join(","));
  url.searchParams.set("search_term", params.query);
  url.searchParams.set(
    "results_wanted",
    String(Math.min(params.results_wanted ?? 15, 50)),
  );
  url.searchParams.set("description_format", "markdown");

  if (params.location) url.searchParams.set("location", params.location);
  if (params.job_type) url.searchParams.set("job_type", params.job_type);
  if (params.is_remote !== undefined)
    url.searchParams.set("is_remote", String(params.is_remote));
  if (params.hours_old)
    url.searchParams.set("hours_old", String(params.hours_old));
  if (params.distance)
    url.searchParams.set("distance", String(params.distance));

  let data: any;
  try {
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Job API ${res.status}: ${text.slice(0, 200)}`);
    }
    data = (await res.json()) as { jobs?: any[] };
  } catch (e: any) {
    const stale = await readCacheStale("jobapi", cacheParams);
    if (stale) {
      try {
        return JSON.parse(stale) as Job[];
      } catch {}
    }
    throw e;
  }

  if (!data.jobs || !Array.isArray(data.jobs)) return [];

  const jobs: Job[] = data.jobs.map(
    (j: any): Job => ({
      title: j.title ?? "Unknown",
      company: j.company ?? "Unknown",
      location: j.location
        ? typeof j.location === "string"
          ? j.location
          : [j.location.city, j.location.state, j.location.country]
              .filter(Boolean)
              .join(", ")
        : "",
      url: j.job_url ?? j.url ?? "",
      description: j.description ?? undefined,
      salary: fmtSalary(j),
      jobType: j.job_type ?? undefined,
      isRemote: j.is_remote ?? undefined,
      datePosted: fmtDate(j.date_posted),
      site: j.site ?? "unknown",
    }),
  );

  await writeCache("jobapi", cacheParams, JSON.stringify(jobs));

  return jobs;
}

async function fetchRemotiveDirect(
  query: string,
  signal?: AbortSignal,
): Promise<Job[]> {
  const cacheParams: Record<string, unknown> = { query };

  const cached = await readCache("remotive", cacheParams);
  if (cached) {
    try {
      return JSON.parse(cached) as Job[];
    } catch {}
  }

  const url = new URL("https://remotive.com/api/remote-jobs");
  url.searchParams.set("search", query);
  url.searchParams.set("limit", "50");

  let data: any;
  try {
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`Remotive: ${res.status}`);
    data = (await res.json()) as { jobs?: any[] };
  } catch (e: any) {
    const stale = await readCacheStale("remotive", cacheParams);
    if (stale) {
      try {
        return JSON.parse(stale) as Job[];
      } catch {}
    }
    throw e;
  }

  if (!data.jobs) return [];

  const jobs: Job[] = data.jobs.map(
    (j: any): Job => ({
      title: j.title ?? "Unknown",
      company: j.company_name ?? "Unknown",
      location: j.candidate_required_location ?? "Remote",
      url: j.url ?? "",
      description: j.description
        ? j.description.replace(/<[^>]+>/g, "").trim()
        : undefined,
      salary: j.salary ?? undefined,
      jobType: j.job_type ?? undefined,
      isRemote: true,
      datePosted: fmtDate(j.publication_date),
      site: "remotive",
    }),
  );

  await writeCache("remotive", cacheParams, JSON.stringify(jobs));

  return jobs;
}

async function fetchGreenhouse(
  company: string,
  query: string,
  signal?: AbortSignal,
): Promise<Job[]> {
  const cacheParams: Record<string, unknown> = { company, query };

  const cached = await readCache("greenhouse", cacheParams);
  if (cached) {
    try {
      return JSON.parse(cached) as Job[];
    } catch {}
  }

  const slug = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;

  let data: any;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Greenhouse: ${res.status}`);
    data = (await res.json()) as { jobs?: any[] };
  } catch (e: any) {
    const stale = await readCacheStale("greenhouse", cacheParams);
    if (stale) {
      try {
        return JSON.parse(stale) as Job[];
      } catch {}
    }
    throw e;
  }

  if (!data.jobs) return [];

  const q = query.toLowerCase();
  const jobs: Job[] = data.jobs
    .filter((j: any) => {
      const text = `${j.title} ${j.location?.name ?? ""}`.toLowerCase();
      return text.includes(q);
    })
    .map(
      (j: any): Job => ({
        title: j.title,
        company,
        location: j.location?.name ?? "",
        url:
          j.absolute_url ?? `https://boards.greenhouse.io/${slug}/jobs/${j.id}`,
        description: j.content
          ? j.content.replace(/<[^>]+>/g, "").trim()
          : undefined,
        datePosted: fmtDate(j.first_published),
        isRemote: j.location?.name?.toLowerCase().includes("remote"),
        site: "greenhouse",
      }),
    );

  await writeCache("greenhouse", cacheParams, JSON.stringify(jobs));

  return jobs;
}

function classifyWorkMode(
  job: Job,
): "remote" | "hybrid" | "onsite" | "unknown" {
  const loc = (job.location ?? "").toLowerCase();
  const desc = (job.description ?? "").toLowerCase();
  const combined = `${loc} ${desc.slice(0, 500)}`;

  if (
    job.isRemote ||
    combined.includes("fully remote") ||
    combined.includes("100% remote") ||
    combined.includes("work from anywhere")
  ) {
    return "remote";
  }
  if (
    combined.includes("hybrid") ||
    combined.includes("2-3 days") ||
    combined.includes("3 days a week") ||
    combined.includes("partially remote")
  ) {
    return "hybrid";
  }
  if (
    combined.includes("onsite") ||
    combined.includes("on-site") ||
    combined.includes("in-office") ||
    combined.includes("in office")
  ) {
    return "onsite";
  }
  if (loc.includes("remote")) return "remote";
  return "unknown";
}

type EnrichmentPlatform = "workable" | "workday" | "kalibrr" | "greenhouse_ats";

function detectEnrichmentPlatform(
  url: string,
): { platform: EnrichmentPlatform; id: string } | null {
  let m: RegExpMatchArray | null;

  m = url.match(/apply\.workable\.com\/([^/]+)\/j\/([A-Z0-9]+)/);
  if (m) return { platform: "workable", id: `${m[1]}/${m[2]}` };

  m = url.match(
    /([a-z0-9-]+)\.workdaystudios\.com\/.*?\/job\/([a-zA-Z0-9_-]+)/,
  );
  if (m) return { platform: "workday", id: `${m[1]}/${m[2]}` };

  m = url.match(
    /([a-z0-9-]+)\.wd1\.myworkdayjobs\.com\/.*?\/job\/([a-zA-Z0-9_]+)/,
  );
  if (m) return { platform: "workday", id: `${m[1]}/${m[2]}` };

  m = url.match(/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com\/(.+?)\/job\/(.+)/);
  if (m) return { platform: "workday", id: `${m[1]}/${m[2]}/${m[3]}` };

  m = url.match(/([a-z0-9-]+)\.myworkdayjobs\.com\/(.+?)\/job\/(.+)/);
  if (m) return { platform: "workday", id: `${m[1]}/${m[2]}/${m[3]}` };

  m = url.match(/boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (m) return { platform: "greenhouse_ats", id: `${m[1]}/${m[2]}` };

  m = url.match(/kalibrr\.com\/c\/[^/]+\/jobs\/(\d+)\//);
  if (m) return { platform: "kalibrr", id: m[1] };

  return null;
}

async function enrichWorkable(
  account: string,
  shortcode: string,
  signal?: AbortSignal,
): Promise<ApplyInfo | null> {
  const cacheParams = { platform: "workable", account, shortcode };
  const cached = await readCache("enrich", cacheParams);
  if (cached) {
    try {
      return JSON.parse(cached) as ApplyInfo;
    } catch {}
  }

  try {
    const formRes = await fetch(
      `https://apply.workable.com/api/v1/jobs/${shortcode}/form`,
      { signal },
    );

    if (!formRes.ok) return null;

    const formData = (await formRes.json()) as {
      name?: string;
      fields?: {
        id?: string;
        name?: string;
        type?: string;
        label?: string;
        required?: boolean;
        supportedFileTypes?: string[];
        options?: { label?: string }[];
      }[];
    }[];

    const fields: ApplyField[] = [];
    for (const section of formData) {
      for (const f of section.fields ?? []) {
        fields.push({
          name: f.id ?? f.name ?? "",
          type: f.type ?? "text",
          required: f.required ?? false,
          label: f.label ?? f.id ?? f.name,
          options: f.supportedFileTypes ?? f.options?.map((o) => o.label ?? ""),
        });
      }
    }

    const info: ApplyInfo = {
      platform: "Workable",
      fields,
      notes: "No account needed. Direct apply via public form.",
    };

    await writeCache("enrich", cacheParams, JSON.stringify(info));
    return info;
  } catch {
    return null;
  }
}

async function enrichGreenhouseJob(
  slug: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<ApplyInfo | null> {
  const cacheParams = { platform: "greenhouse_job", slug, jobId };
  const cached = await readCache("enrich", cacheParams);
  if (cached) {
    try {
      return JSON.parse(cached) as ApplyInfo;
    } catch {}
  }

  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?questions=true`,
      { signal },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      questions?: {
        label?: string;
        required?: boolean;
        fields?: {
          name?: string;
          type?: string;
          values?: { value?: string; label?: string }[];
        }[];
      }[];
    };

    const fields: ApplyField[] = [];
    for (const q of data.questions ?? []) {
      const primaryField = q.fields?.[0];
      const opts = primaryField?.values?.map((v) => v.label ?? v.value ?? "");
      fields.push({
        name: primaryField?.name ?? "",
        type: primaryField?.type?.replace("input_", "") ?? "text",
        required: q.required ?? false,
        label: q.label,
        options: opts?.length ? opts : undefined,
      });
    }

    const info: ApplyInfo = {
      platform: "Greenhouse",
      fields,
      notes: "No account needed. Apply via the Greenhouse board.",
    };

    await writeCache("enrich", cacheParams, JSON.stringify(info));
    return info;
  } catch {
    return null;
  }
}

async function enrichKalibrr(
  jobId: string,
  signal?: AbortSignal,
): Promise<ApplyInfo | null> {
  const cacheParams = { platform: "kalibrr", jobId };
  const cached = await readCache("enrich", cacheParams);
  if (cached) {
    try {
      return JSON.parse(cached) as ApplyInfo;
    } catch {}
  }

  try {
    const res = await fetch(`https://www.kalibrr.com/c/k/jobs/${jobId}`, {
      signal,
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const m = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) return null;

    const d = JSON.parse(m[1]) as {
      props?: {
        pageProps?: {
          job?: {
            name?: string;
            educationLevelMin?: number;
            monthsWorkExperience?: number;
            qualifications?: string;
            isWorkFromHome?: boolean;
            isHybrid?: boolean;
            isOpenToFreshGrads?: boolean;
            preferredCourses?: string[];
            function?: string;
          };
        };
      };
    };

    const job = d.props?.pageProps?.job;
    if (!job) return null;

    const fields: ApplyField[] = [
      {
        name: "resume",
        type: "file",
        required: true,
        label: "Resume/CV",
      },
    ];

    if (job.educationLevelMin)
      fields.push({
        name: "education",
        type: "text",
        required: false,
        label: `Education (min level: ${job.educationLevelMin})`,
      });

    if ((job.monthsWorkExperience ?? 0) > 0)
      fields.push({
        name: "experience",
        type: "text",
        required: false,
        label: `Experience (${job.monthsWorkExperience} months)`,
      });

    if (job.preferredCourses?.length)
      fields.push({
        name: "courses",
        type: "text",
        required: false,
        label: `Preferred courses: ${job.preferredCourses.join(", ")}`,
      });

    const notes: string[] = ["Requires Kalibrr account to apply."];
    if (job.isWorkFromHome) notes.push("Work from home eligible.");
    if (job.isHybrid) notes.push("Hybrid eligible.");
    if (job.isOpenToFreshGrads) notes.push("Open to fresh grads.");

    const info: ApplyInfo = {
      platform: "Kalibrr",
      fields,
      notes: notes.join(" "),
    };

    await writeCache("enrich", cacheParams, JSON.stringify(info));
    return info;
  } catch {
    return null;
  }
}

async function enrichJob(job: Job, signal?: AbortSignal): Promise<void> {
  const target = job.applyUrl ?? job.url;
  const detected = detectEnrichmentPlatform(target);
  if (!detected) return;

  try {
    switch (detected.platform) {
      case "workable": {
        const [account, shortcode] = detected.id.split("/");
        if (account && shortcode) {
          job.applyInfo =
            (await enrichWorkable(account, shortcode, signal)) ?? undefined;
        }
        break;
      }
      case "greenhouse_ats": {
        const [slug, jobId] = detected.id.split("/");
        if (slug && jobId) {
          job.applyInfo =
            (await enrichGreenhouseJob(slug, jobId, signal)) ?? undefined;
        }
        break;
      }
      case "kalibrr": {
        job.applyInfo = (await enrichKalibrr(detected.id, signal)) ?? undefined;
        break;
      }
    }
  } catch {}
}

function extractLinkedInJobId(url: string): string | null {
  const m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
  return m ? m[1] : null;
}

function extractLinkedInUsername(url: string): string | null {
  const m = url.match(/linkedin\.com\/in\/([^/?&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function refreshLiAtCookie(config: Config): Promise<boolean> {
  try {
    const home = process.env.HOME || homedir();
    const candidates = [
      join(home, ".zen"),
      join(home, ".mozilla", "firefox"),
      join(home, ".var", "app", "io.github.zen_browser.zen", ".zen"),
      join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    ];
    for (const base of candidates) {
      if (!existsSync(base)) continue;
      const entries = await readdir(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dbPath = join(base, e.name, "cookies.sqlite");
        if (!existsSync(dbPath)) continue;
        const tmpDb = join(
          tmpdir(),
          "cookies-refresh-" + Date.now() + ".sqlite",
        );
        try {
          await execFileAsync("cp", [dbPath, tmpDb]);
          const { stdout } = await execFileAsync("sqlite3", [
            tmpDb,
            "SELECT value FROM moz_cookies WHERE host LIKE '%linkedin%' AND name='li_at' ORDER BY expiry DESC LIMIT 1;",
          ]);
          await unlink(tmpDb).catch(() => {});
          const val = stdout.trim();
          if (val && val.length > 50 && val !== config.linkedin?.li_at) {
            config.linkedin = { ...config.linkedin, li_at: val };
            await saveConfig(config);
            return true;
          }
        } catch {
          await unlink(tmpDb).catch(() => {});
        }
      }
    }
  } catch {}
  return false;
}

async function fetchLinkedInProfile(
  profileUrl: string,
  config: NonNullable<Config["linkedin"]>,
  signal?: AbortSignal,
): Promise<string | null> {
  const username = extractLinkedInUsername(profileUrl);
  if (!username) return null;
  const cacheParams = { username };
  const cached = await readCache("linkedin_profile", cacheParams);
  if (cached) return cached;

  const c = config;
  const cookieParts = [`li_at=${c.li_at}`];
  if (c.jsessionid) cookieParts.push(`JSESSIONID="${c.jsessionid}"`);
  if (c.bcookie) cookieParts.push(`bcookie="${c.bcookie}"`);
  const headers: Record<string, string> = {
    cookie: cookieParts.join("; "),
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    accept: "application/vnd.linkedin.normalized+json+2.1",
  };
  if (c.jsessionid) headers["csrf-token"] = c.jsessionid;

  try {
    const res = await fetch(`https://www.linkedin.com/in/${username}/`, {
      signal,
      headers: { ...headers, accept: "text/html" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (html.length < 1000) return null;

    const out: string[] = [];
    const titleM = html.match(/<title>([^<]*)<\/title>/);
    if (titleM) out.push(titleM[1].replace(/\s*\|\s*LinkedIn\s*$/i, "").trim());

    let posIdx = 0;
    let edIdx = 0;
    const posRegex = /"title":\s*"([^"]+)"[^}]*?"companyName":\s*"([^"]+)"/g;
    let posMatch;
    while ((posMatch = posRegex.exec(html)) !== null) {
      const title = posMatch[1].replace(/\\"/g, '"');
      const co = posMatch[2].replace(/\\"/g, '"');
      if (posIdx < 10) out.push(title + " at " + co);
      posIdx++;
    }

    const eduRegex = /"schoolName":\s*"([^"]+)"/g;
    let eduMatch;
    while ((eduMatch = eduRegex.exec(html)) !== null) {
      if (edIdx < 5) out.push("Education: " + eduMatch[1]);
      edIdx++;
    }

    if (posIdx > 0 && posIdx < 15) {
      const descRegex = /"description":\s*"([^"]*(?:\\.[^"]*)*)"/g;
      let descMatch;
      let descCount = 0;
      while ((descMatch = descRegex.exec(html)) !== null && descCount < 5) {
        const desc = descMatch[1]
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .slice(0, 300);
        if (desc.length > 30) {
          out.push("Description: " + desc);
          descCount++;
        }
      }
    }

    const result = out.join("\n");
    if (result.length > 300) {
      await writeCache("linkedin_profile", cacheParams, result);
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\- ]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

function formatPlainResumeToMarkdown(plain: string): string {
  return plain
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!^)\*(.+?)\*(?!$)/g, "$1")
    .replace(/^-{3,}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function generateTargetedResume(
  resumeText: string,
  job: Job,
  model: Model<Api>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const jobDescription = job.description
    ? job.description.slice(0, 2000)
    : `${job.title} at ${job.company}`;

  const prompt = `You are a resume tailoring expert. Given the candidate's ACTUAL resume and a specific job listing, create a targeted version.

OUTPUT FORMAT -- follow exactly, including headings and structure:

# SON ROY ALMEROL
<p class="contact">Davao City, Philippines | hire@snry.me | github.com/sonroyaalmerol | linkedin.com/in/sonroyaalmerol</p>

## CAREER OBJECTIVE
One paragraph targeting ${job.company}'s "${job.title}" role specifically.

## WORK EXPERIENCE
### Job Title
#### Company · Location | Date Range
- Reworded bullet using keywords from job description. Active voice.
- Another bullet. Keep facts identical to original resume.

### Next Job Title
#### Company · Location | Date Range
- Bullet.

## EDUCATIONAL BACKGROUND
### Degree Name
#### School · Location | Years
GPA / Honors line.

### Next Degree
#### School · Location | Years
GPA / Honors.

## NOTABLE PROJECTS
### Project Name (stars)
Description line.

### Project Name (stars)
Description line.

## PERSONAL INFORMATION
- Citizenship: Filipino
- Languages: English (Fluent), Filipino (Native), Cebuano (Native)
- Work Setup: Permanent work-from-home ready with reliable internet, dedicated workspace, and remote collaboration tools

<p class="contact">References available upon request.</p>

---

GROUNDING RULES -- every word must be truthful:
1. ONLY use information present in the original resume. Do NOT fabricate ANY experience, skill, certification, tool, or credential.
2. REORDER sections and bullet points to highlight most relevant experience first. Put the most job-relevant role as the first ### under ## WORK EXPERIENCE.
3. REWORD bullet points using keywords and phrasing from the job description -- but NEVER invent new accomplishments.
4. REMOVE entirely any roles, projects, or education that are irrelevant to this specific job. It's better to have a shorter, focused resume.
5. Use the contact line, citizenship, languages, and work setup EXACTLY as shown in the format.
6. Do NOT use horizontal rules (---) anywhere except possibly after PERSONAL INFORMATION.
7. Do NOT use bold (**) or italic (*) inside headings or body text. Only use # ## ### #### heading markers.
8. Do NOT use markdown tables (| |). Use bullet lists for PERSONAL INFORMATION.

ORIGINAL RESUME:
${resumeText}

JOB LISTING:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${jobDescription}`;

  try {
    const result = await complete(
      model,
      {
        systemPrompt:
          "You are a resume tailoring expert. You output exactly the requested markdown format. You never fabricate experience.",
        messages: [
          {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, signal, maxTokens: 4096 },
    );

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .replace(/^```(?:markdown|plaintext|text)?\n?/i, "")
      .replace(/^```\n?/m, "")
      .replace(/```$/m, "")
      .trim();

    if (!text) return null;
    return formatPlainResumeToMarkdown(text);
  } catch {
    return null;
  }
}

async function convertMdToPdf(
  mdPath: string,
  pdfPath: string,
): Promise<boolean> {
  const css = [
    "body {",
    "  font-family: DejaVu Sans, sans-serif;",
    "  font-size: 10pt;",
    "  line-height: 1.35;",
    "  color: #000;",
    "  max-width: 7.5in;",
    "  margin: 0 auto;",
    "  padding: 0.25in 0.4in;",
    "}",
    "h1 { font-size: 14pt; text-align: center; margin: 0 0 2pt 0; font-weight: bold; letter-spacing: 1pt; }",
    "h2 { font-size: 10.5pt; font-weight: bold; letter-spacing: 1pt; border-bottom: 1px solid #000; padding-bottom: 2pt; margin: 12pt 0 4pt 0; }",
    "h3 { font-size: 10.5pt; font-weight: bold; margin: 0 0 1pt 0; }",
    "h4 { font-size: 10pt; font-weight: normal; margin: 0 0 1pt 0; color: #222; }",
    "p { font-size: 10pt; margin: 0 0 1pt 0; }",
    "ul, ul li, ul.task-list { list-style-type: disc !important; }",
    "ul { margin: 0; padding-left: 18pt; }",
    "li { font-size: 10pt; margin: 0 0 1pt 0; }",
    "hr { display: none; }",
    "h1.title { display: none; }",
    ".contact { text-align: center; font-size: 9.5pt; margin: 0 0 10pt 0; color: #000; }",
  ].join("\n");

  const htmlPath = join(tmpdir(), "resume-html-" + Date.now() + ".html");
  const cssPath = join(tmpdir(), "resume-css-" + Date.now() + ".css");

  await writeFile(cssPath, "<style>" + css + "</style>", "utf8");
  await execFileAsync("pandoc", [
    mdPath,
    "-o",
    htmlPath,
    "--standalone",
    "--metadata",
    "title=Resume",
    "--include-in-header",
    cssPath,
  ]);

  await execFileAsync("wkhtmltopdf", [
    "--enable-local-file-access",
    "--quiet",
    htmlPath,
    pdfPath,
  ]);

  if (!existsSync(pdfPath)) {
    throw new Error("wkhtmltopdf did not produce output file");
  }

  unlink(htmlPath).catch(function () {});
  unlink(cssPath).catch(function () {});
  return true;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "job_search",
    label: "Job Search",
    description:
      "Search for jobs across Indeed, LinkedIn, RemoteOK, Remotive, and Greenhouse. No API keys required. Supports keyword search, location filtering, work mode (remote/hybrid/onsite), job type, recency, and resume-based match scoring. Provide a resume file path to rank results by relevance to your experience. When LinkedIn li_at cookie is configured, direct apply URLs are resolved automatically. Application form fields are automatically enriched for Workable, Greenhouse, and Kalibrr job listings.",
    promptSnippet:
      "Search for jobs across global platforms with optional resume matching",
    promptGuidelines: [
      "Use job_search when the user asks to find jobs, search for openings, or explore career opportunities.",
      "job_search supports resume-based scoring: provide the resume parameter with a file path to rank jobs by relevance.",
      "job_search also supports linkedin_profile (URL) to use a LinkedIn profile as basis instead of a resume file. Requires li_at cookie.",
      "job_search supports work_mode filter: remote, hybrid, or onsite.",
      "job_search supports multiple platforms. Suggest specifying a company name for direct Greenhouse ATS searches.",
      "Results include title, company, location, salary (when available), direct application links, optionally match scores, and application form field details for supported platforms.",
      "Config file at ~/.config/pi-job-search/config.json for LinkedIn session cookie (li_at) to enable direct apply URL resolution.",
      "Set generate_resumes: true (with a resume) to auto-generate targeted .pdf resumes and .txt metadata files for each job match. Grounded -- nothing fabricated.",
    ],
    parameters: SearchParams,

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("job_search "));
      text += theme.fg("accent", `"${args.query}"`);
      if (args.location) text += theme.fg("muted", ` in ${args.location}`);
      if (args.company) text += theme.fg("muted", ` @ ${args.company}`);
      if (args.work_mode) text += theme.fg("dim", ` ${args.work_mode}`);
      else if (args.is_remote) text += theme.fg("dim", " remote");
      if (args.resume) text += theme.fg("accent", " +resume");
      if (args.linkedin_profile) text += theme.fg("accent", " +linkedin");
      if (args.generate_resumes) text += theme.fg("accent", " +generate");
      if (args.open_apply_urls) text += theme.fg("accent", " +open");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Searching jobs..."), 0, 0);

      const content = result.content[0];
      if (content?.type !== "text")
        return new Text(theme.fg("dim", "No results"), 0, 0);

      const count = (content.text.match(/^\d+\./gm) || []).length;
      if (count === 0) return new Text(theme.fg("dim", "No jobs found"), 0, 0);

      const hasScores = /\[\d+% match\]/.test(content.text);
      let text = theme.fg(
        "success",
        `✓ ${count} job${count !== 1 ? "s" : ""} found`,
      );
      if (hasScores) text += theme.fg("accent", " (resume-scored)");
      if (expanded) {
        const preview = content.text.split("\n").slice(0, 30).join("\n");
        text += "\n" + theme.fg("dim", preview);
      }
      return new Text(text, 0, 0);
    },

    async execute(_id, params, signal, onUpdate, ctx) {
      await ensureConfigExists();

      onUpdate?.({
        content: [
          {
            type: "text",
            text: "Searching across job platforms...",
          },
        ],
      });

      const config = await loadConfig();
      const requested = params.sites ?? ([...allPlatforms] as string[]);
      const limit = Math.min(params.results_wanted ?? 15, 50);
      let allJobs: Job[] = [];
      const errors: string[] = [];

      const promises: Promise<void>[] = [];

      const apiSites = requested.filter((s) =>
        (jobApiSites as readonly string[]).includes(s),
      ) as JobApiSite[];

      if (apiSites.length > 0) {
        promises.push(
          fetchJobApi(apiSites, params, signal)
            .then((jobs) => allJobs.push(...jobs.slice(0, limit)))
            .catch((e: any) =>
              errors.push(`Job API (${apiSites.join(",")}): ${e.message}`),
            ),
        );
      }

      const needsRemotiveDirect =
        requested.includes("remotive") && !apiSites.includes("remotive");
      if (needsRemotiveDirect) {
        promises.push(
          fetchRemotiveDirect(params.query, signal)
            .then((jobs) => allJobs.push(...jobs.slice(0, limit)))
            .catch((e: any) => errors.push(`Remotive: ${e.message}`)),
        );
      }

      if (requested.includes("greenhouse") && params.company) {
        promises.push(
          fetchGreenhouse(params.company!, params.query, signal)
            .then((jobs) => allJobs.push(...jobs.slice(0, limit)))
            .catch((e: any) => errors.push(`Greenhouse: ${e.message}`)),
        );
      }

      await Promise.all(promises);

      const liConfig = config.linkedin;
      if (liConfig?.li_at && allJobs.length > 0) {
        refreshLiAtCookie(config).catch(function () {});
        const linkedInJobs = allJobs.filter(
          (j) => j.site === "linkedin" && j.url,
        );
        if (linkedInJobs.length > 0) {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Resolving ${linkedInJobs.length} LinkedIn apply URLs...`,
              },
            ],
          });

          const resolvePromises = linkedInJobs.map(async (job) => {
            const jobId = extractLinkedInJobId(job.url);
            if (!jobId) return;

            try {
              const info = await resolveLinkedInApplyUrl(
                jobId,
                liConfig,
                signal,
              );
              if (info?.companyApplyUrl) {
                job.applyUrl = info.companyApplyUrl;
              } else if (info?.easyApplyUrl) {
                job.applyUrl = `LinkedIn Easy Apply: ${info.easyApplyUrl}`;
              }
            } catch {}
          });

          await Promise.all(resolvePromises);
        }
      }

      const enrichTargets = allJobs.filter((j) => {
        const target = j.applyUrl ?? j.url;
        return detectEnrichmentPlatform(target) !== null;
      });
      if (enrichTargets.length > 0) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Fetching application details for ${enrichTargets.length} jobs...`,
            },
          ],
        });

        const enrichBatches: Job[][] = [];
        for (let i = 0; i < enrichTargets.length; i += 5) {
          enrichBatches.push(enrichTargets.slice(i, i + 5));
        }
        for (const batch of enrichBatches) {
          await Promise.all(batch.map((j) => enrichJob(j, signal)));
        }
      }

      if (params.is_remote === true) {
        allJobs = allJobs.filter(
          (j) => j.isRemote || j.location?.toLowerCase().includes("remote"),
        );
      } else if (params.is_remote === false) {
        allJobs = allJobs.filter(
          (j) => !j.isRemote && !j.location?.toLowerCase().includes("remote"),
        );
      }

      if (params.work_mode) {
        const mode = params.work_mode as string;
        allJobs = allJobs.filter((j) => {
          const wm = classifyWorkMode(j);
          return wm === mode || wm === "unknown";
        });
      }

      if (params.hours_old) {
        const cutoff = Date.now() - params.hours_old * 3600 * 1000;
        allJobs = allJobs.filter((j) => {
          if (!j.datePosted) return true;
          const d = new Date(j.datePosted).getTime();
          return d >= cutoff;
        });
      }

      const seen = new Set<string>();
      let deduped = allJobs.filter((j) => {
        const key = `${j.title.toLowerCase()}|${j.company.toLowerCase()}|${j.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      let profileText = "";
      if (deduped.length > 0) {
        if (params.resume) {
          onUpdate?.({
            content: [{ type: "text", text: "Reading resume..." }],
          });
          try {
            profileText = await readResumeFile(
              params.resume.startsWith("~/")
                ? `${process.env.HOME}${params.resume.slice(1)}`
                : params.resume,
            );
          } catch (e: any) {
            errors.push(`Resume: ${e.message}`);
          }
        } else if (params.linkedin_profile) {
          await refreshLiAtCookie(config).catch(function () {});
          const freshLiConfig = config.linkedin;
          onUpdate?.({
            content: [{ type: "text", text: "Fetching LinkedIn profile..." }],
          });
          try {
            const linkedinText = await fetchLinkedInProfile(
              params.linkedin_profile,
              freshLiConfig ?? { li_at: "" },
              signal,
            );
            if (linkedinText) {
              profileText = linkedinText;
            } else {
              errors.push("LinkedIn profile: could not fetch");
            }
          } catch (e: any) {
            errors.push(`LinkedIn profile: ${e.message}`);
          }
        }
      }

      if (profileText && deduped.length > 0) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Scoring ${deduped.length} jobs...`,
            },
          ],
        });

        if (profileText.length > 0 && ctx.model && ctx.modelRegistry) {
          try {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
            if (!auth.ok) {
              errors.push(`Resume scoring: no API key (${auth.error})`);
            } else {
              deduped = await scoreJobsAgainstResume(
                deduped,
                profileText,
                ctx.model,
                auth.apiKey ?? "",
                signal,
              );

              deduped.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

              if (params.min_match_score !== undefined) {
                deduped = deduped.filter(
                  (j) =>
                    j.matchScore !== undefined &&
                    j.matchScore >= params.min_match_score!,
                );
              }
            }
          } catch (e: any) {
            errors.push(`Resume scoring: ${e.message}`);
          }
        } else if (!ctx.model) {
          errors.push("Resume scoring: no model available");
        }
      }

      let generatedResumes: string[] = [];
      if (params.generate_resumes && profileText && deduped.length > 0) {
        const maxResumes = Math.min(params.max_resumes ?? 10, 20);
        const toGenerate = deduped.slice(0, maxResumes);
        const outputDir = params.resume_output_dir
          ? params.resume_output_dir.startsWith("~/")
            ? `${process.env.HOME}${params.resume_output_dir.slice(1)}`
            : params.resume_output_dir
          : join(homedir(), "job-resumes");

        if (!existsSync(outputDir)) {
          await mkdir(outputDir, { recursive: true });
        }

        if (ctx.model && ctx.modelRegistry) {
          try {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
            if (auth.ok && auth.apiKey) {
              for (let i = 0; i < toGenerate.length; i++) {
                if (signal?.aborted) break;
                const job = toGenerate[i];
                onUpdate?.({
                  content: [
                    {
                      type: "text",
                      text: `Generating targeted resume ${i + 1}/${toGenerate.length}: ${job.company} -- ${job.title}...`,
                    },
                  ],
                });

                const mdContent = await generateTargetedResume(
                  profileText,
                  job,
                  ctx.model,
                  auth.apiKey,
                  signal,
                );

                if (!mdContent) continue;

                const baseName = sanitizeFilename(
                  `${job.company}_${job.title}`,
                );
                const pdfPath = join(outputDir, `${baseName}.pdf`);
                const tmpMd = join(
                  tmpdir(),
                  "resume-gen-" + Date.now() + ".md",
                );

                await writeFile(tmpMd, mdContent, "utf8");
                await convertMdToPdf(tmpMd, pdfPath);
                unlink(tmpMd).catch(function () {});

                const metadata = [
                  "Title: " + (job.title || ""),
                  "Company: " + (job.company || ""),
                  "Location: " + (job.location || ""),
                  "URL: " + (job.url || ""),
                  "Apply: " + (job.applyUrl || ""),
                  "Salary: " + (job.salary || ""),
                  "Job Type: " + (job.jobType || ""),
                  "Posted: " + (job.datePosted || ""),
                  "Site: " + (job.site || ""),
                  "Match Score: " +
                    (job.matchScore !== undefined ? job.matchScore + "%" : ""),
                  "Match Reason: " + (job.matchReason || ""),
                ];
                if (job.description) {
                  metadata.push("\nDescription:\n" + job.description);
                }

                const txtPath = join(outputDir, `${baseName}.txt`);
                await writeFile(txtPath, metadata.join("\n"), "utf8");

                generatedResumes.push(pdfPath);
              }
            }
          } catch (e: any) {
            errors.push(`Resume generation: ${e.message}`);
          }
        }
      }

      let output = fmtJobs(deduped);

      if (generatedResumes.length > 0) {
        output += `\n\n---\n📄 **Generated ${generatedResumes.length} targeted resumes:**`;
        for (const p of generatedResumes) {
          output += `\n- ${p}`;
        }
      }

      if (errors.length > 0) {
        output += `\n\n---\n⚠ Some sources had errors:\n${errors.map((e) => `- ${e}`).join("\n")}`;
      }

      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Output truncated. ${deduped.length} total results. Use more specific filters to narrow results.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { count: deduped.length, errors },
      };
    },
  });
}
