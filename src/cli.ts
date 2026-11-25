import { Command } from "commander";
import {
  campaignDraftCommand,
  campaignInitCommand,
  useCommand,
} from "./commands/campaign.js";
import type { GlobalOptions } from "./commands/context.js";
import { logCommand, reportCommand } from "./commands/ledger.js";
import {
  analyzeCommand,
  exportCommand,
  fetchCommand,
  ingestCommand,
  momentsCommand,
  planCommand,
  renderCommand,
  runCommand,
  transcribeCommand,
  validateCommand,
} from "./commands/pipeline.js";
import { doctorCommand, modelsCommand } from "./commands/system.js";

const program = new Command();

program
  .name("clipper")
  .description(
    "Campaign-aware CLI that turns source footage into upload-ready vertical clips",
  )
  .version("0.1.0")
  .option("-c, --campaign <name>", "Campaign name")
  .option("--workspace <dir>", "Workspace directory", "./workspace")
  .option("--json", "Output JSON where supported")
  .option("--model-plan <id>", "Override Mistral model for plan task")
  .option("--model-moments <id>", "Override Mistral model for moments task")
  .option("--model-draft <id>", "Override Mistral model for draft task")
  .option("--model-vision <id>", "Override Mistral model for vision task")
  .option("--model-transcribe <id>", "Override Mistral model for transcribe task");

function globals(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

program
  .command("doctor")
  .description("Check ffmpeg, NVENC, fonts, MISTRAL_API_KEY, and configured models")
  .action(() => doctorCommand(globals()));

program
  .command("models")
  .description("List available Mistral models and show task-to-model mapping")
  .action(() => modelsCommand(globals()));

const campaignCmd = program
  .command("campaign")
  .description("Manage campaign profiles");

campaignCmd
  .command("init <name>")
  .description("Scaffold campaigns/<name>/profile.yaml and assets/")
  .action((name: string) => campaignInitCommand(name, globals()));

campaignCmd
  .command("draft")
  .requiredOption("--brief <file>", "Path to brief (.txt, .md, .pdf)")
  .requiredOption("--name <name>", "Campaign name")
  .description("Draft a campaign profile from a brief using the LLM")
  .action((cmdOpts: { brief: string; name: string }) =>
    campaignDraftCommand(cmdOpts, globals()),
  );

program
  .command("use <name>")
  .description("Set the active campaign")
  .action((name: string) => useCommand(name, globals()));

program
  .command("fetch")
  .description("Run the campaign profile's sources.fetch command")
  .action(() => fetchCommand(globals()));

program
  .command("ingest [path]")
  .description("Probe and register source video files")
  .option("--copy", "Copy files into workspace instead of symlinking")
  .action(async (inputPath: string | undefined, cmdOpts: { copy?: boolean }) => {
    await ingestCommand(inputPath, cmdOpts, globals());
  });

program
  .command("analyze [clipId]")
  .description("Run audio/motion/scene analysis and window selection")
  .option("--vision", "Describe sampled frames with Mistral vision model")
  .option("--no-trim", "Disable trimming of source clips")
  .option("--force", "Re-run analysis even if cached")
  .action(
    (
      clipId: string | undefined,
      cmdOpts: { vision?: boolean; trim?: boolean; force?: boolean },
    ) =>
      analyzeCommand(
        clipId,
        {
          vision: cmdOpts.vision,
          noTrim: cmdOpts.trim === false,
          force: cmdOpts.force,
        },
        globals(),
      ),
  );

program
  .command("transcribe [clipId]")
  .description("Transcribe speech to text for long-form sources")
  .option("--provider <name>", "Transcription provider: mistral | whisper-cmd", "mistral")
  .option("--force", "Re-run transcription even if cached")
  .action(
    (
      clipId: string | undefined,
      cmdOpts: { provider?: string; force?: boolean },
    ) => transcribeCommand(clipId, cmdOpts, globals()),
  );

program
  .command("moments [clipId]")
  .description("Rank candidate moments from transcript")
  .option("--top <n>", "Maximum candidate moments to keep", "10")
  .option("--force", "Re-run moment ranking even if cached")
  .action(
    (clipId: string | undefined, cmdOpts: { top?: string; force?: boolean }) =>
      momentsCommand(
        clipId,
        { top: Number(cmdOpts.top ?? 10), force: cmdOpts.force },
        globals(),
      ),
  );

program
  .command("plan [clipId]")
  .description("Generate hooks and platform captions")
  .option("--context <text>", "Additional factual context for hooks/captions")
  .option("--no-llm", "Use fallback templates without calling the LLM")
  .option("--force", "Re-run planning even if cached")
  .action(
    (
      clipId: string | undefined,
      cmdOpts: { context?: string; llm?: boolean; force?: boolean },
    ) =>
      planCommand(
        clipId,
        {
          context: cmdOpts.context,
          noLlm: cmdOpts.llm === false,
          force: cmdOpts.force,
        },
        globals(),
      ),
  );

program
  .command("render [clipId]")
  .description("Render vertical 9:16 variants with overlays and watermark")
  .option("--variants <n>", "Number of variants to render", "1")
  .option("--reframe <mode>", "Reframe mode: auto | center | motion | none")
  .option("--slowmo", "Enable slow-motion speed ramp around peak")
  .option("--zoom", "Enable gentle punch-in zoom around peak")
  .option("--counter", "Enable shot counter overlay")
  .option("--no-trim", "Render full source without trimming")
  .action(
    (
      clipId: string | undefined,
      cmdOpts: {
        variants?: string;
        reframe?: "auto" | "center" | "motion" | "none";
        slowmo?: boolean;
        zoom?: boolean;
        counter?: boolean;
        trim?: boolean;
      },
    ) =>
      renderCommand(
        clipId,
        {
          variants: Number(cmdOpts.variants ?? 1),
          reframe: cmdOpts.reframe,
          slowmo: cmdOpts.slowmo,
          zoom: cmdOpts.zoom,
          counter: cmdOpts.counter,
          noTrim: cmdOpts.trim === false,
        },
        globals(),
      ),
  );

program
  .command("validate [clipId]")
  .description("Validate rendered clips and copy against campaign rules")
  .action((clipId: string | undefined) => validateCommand(clipId, globals()));

program
  .command("export")
  .description("Copy passing renders to out/ and generate captions.md")
  .action(() => exportCommand(globals()));

program
  .command("run [path]")
  .description("Run the full pipeline end to end")
  .option("--top <n>", "Keep top N clips by action score")
  .option("--limit <n>", "Limit number of clips processed")
  .option("--fetch", "Run sources.fetch before ingesting")
  .option("--variants <n>", "Variants per clip", "1")
  .option("--reframe <mode>", "Reframe mode: auto | center | motion | none")
  .option("--slowmo", "Enable slow-mo around peak")
  .option("--zoom", "Enable zoom around peak")
  .option("--counter", "Enable shot counter")
  .option("--no-trim", "Disable trimming")
  .option("--no-llm", "Skip LLM and use fallback templates")
  .option("--vision", "Run vision frame description")
  .option("--context <text>", "Additional factual context")
  .option("--force", "Reprocess even if already exported")
  .action(
    (
      inputPath: string | undefined,
      cmdOpts: {
        top?: string;
        limit?: string;
        fetch?: boolean;
        variants?: string;
        reframe?: "auto" | "center" | "motion" | "none";
        slowmo?: boolean;
        zoom?: boolean;
        counter?: boolean;
        trim?: boolean;
        llm?: boolean;
        vision?: boolean;
        context?: string;
        force?: boolean;
      },
    ) =>
      runCommand(
        inputPath,
        {
          top: cmdOpts.top ? Number(cmdOpts.top) : undefined,
          limit: cmdOpts.limit ? Number(cmdOpts.limit) : undefined,
          fetch: cmdOpts.fetch,
          variants: cmdOpts.variants ? Number(cmdOpts.variants) : 1,
          reframe: cmdOpts.reframe,
          slowmo: cmdOpts.slowmo,
          zoom: cmdOpts.zoom,
          counter: cmdOpts.counter,
          noTrim: cmdOpts.trim === false,
          noLlm: cmdOpts.llm === false,
          vision: cmdOpts.vision,
          context: cmdOpts.context,
          force: cmdOpts.force,
        },
        globals(),
      ),
  );

program
  .command("log")
  .description("Log a posted clip's performance to ledger.csv")
  .requiredOption("--clip <id>", "Clip ID")
  .requiredOption("--platform <p>", "Platform (tiktok, instagram, youtube)")
  .requiredOption("--views <n>", "View count")
  .option("--payout <usd>", "Payout in USD", "0")
  .option("--minutes <n>", "Minutes spent", "0")
  .option("--url <u>", "Post URL", "")
  .action(
    (cmdOpts: {
      clip: string;
      platform: string;
      views: string;
      payout?: string;
      minutes?: string;
      url?: string;
    }) =>
      logCommand(
        {
          clip: cmdOpts.clip,
          platform: cmdOpts.platform,
          views: Number(cmdOpts.views),
          payout: Number(cmdOpts.payout ?? 0),
          minutes: Number(cmdOpts.minutes ?? 0),
          url: cmdOpts.url,
        },
        globals(),
      ),
  );

program
  .command("report")
  .description("Show totals: views, payout, $/hour, per platform")
  .action(() => reportCommand(globals()));

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
