// Quest Mode: a game layer over your agents. The status-bar copy is the engine:
// it watches agent state changes, scores them (XP, coins, combos, streaks,
// daily quests, achievements) and keeps the score in shared("quest").
// Other copies (props.view) draw the quest log popup and the level-up screen.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, theme, shared, setShared, props, openOverlay, closeOverlay, notify, playSound, appHome, exec, home, nextCommand, readTextFile, writeTextFile } from "herdr";

const ICONS = "custom-icons/retro";
const COMBO_WINDOW = 5 * 60 * 1000;
const FAST_REPLY = 60 * 1000;
const need = (lv) => 100 + 100 * lv;
const stageOf = (lv) => (lv >= 20 ? 3 : lv >= 10 ? 2 : lv >= 5 ? 1 : 0);

const QUEST_POOL = [
  { id: "ship5", text: "Finish 5 agent tasks", goal: 5 },
  { id: "fast3", text: "Answer 3 “needs you” within a minute", goal: 3 },
  { id: "herd3", text: "Run 3 agents at the same time", goal: 1 },
  { id: "combo3", text: "Reach a x3 combo", goal: 1 },
  { id: "remote2", text: "Finish 2 tasks on Remote", goal: 2 },
  { id: "early", text: "Finish a task before 10:00", goal: 1 },
];
const ACHIEVEMENTS = [
  { id: "hello", name: "Hello, Herd", how: "First finished task" },
  { id: "herder", name: "Herder", how: "3 agents working at once" },
  { id: "quick", name: "Quick Draw", how: "Answer in under 10 seconds" },
  { id: "combo4", name: "Chain Reaction", how: "Reach a x4 combo" },
  { id: "merge", name: "Shipped It", how: "A PR of yours merged" },
  { id: "night", name: "Night Shift", how: "A task done after midnight" },
  { id: "worlds", name: "Two Worlds", how: "Agents working on Local and Remote at once" },
  { id: "century", name: "Century", how: "100 finished tasks" },
];
// GitHub logins to check for merged PRs: null is gh's default login. For several
// accounts, list their config folders under your home, e.g. [".config/gh-work", ".config/gh-home"].
const GH_CONFIGS = [null];

// The machine whose Claude sessions report plan usage: null is this computer, or a
// machine name from `hc machine ls` if you run Claude there.
const USAGE_MACHINE = null;
const QUEST_LOG = { mod: "quest", kind: "popup", width: 360, height: 540, props: { view: "quests" } };
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Quests turn over at 06:00, so a late night still counts as the same day.
const questDay = () => dayKey(new Date(Date.now() - 6 * 3600 * 1000));
const today = () => dayKey(new Date());

function pickQuests(day) {
  let h = 0;
  for (const c of day) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const pool = QUEST_POOL.slice(), out = [];
  while (out.length < 3) { h = (h * 1103515245 + 12345) >>> 0; out.push(pool.splice(h % pool.length, 1)[0]); }
  return out.map((q) => ({ id: q.id, n: 0 }));
}

function fresh() {
  return { v: 1, xp: 0, level: 1, coins: 0, total: 0, days: [], combo: { n: 0, at: 0 }, got: [], quests: { day: questDay(), list: pickQuests(questDay()) }, prs: [], prsReady: false, bonus: [] };
}

function streakOf(days) {
  const set = new Set(days);
  const d = new Date();
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// Quiet hours: no sounds from 20:00 until 08:00.
const QUIET_FROM = 20, QUIET_UNTIL = 8;
const isQuiet = (d = new Date()) => d.getHours() >= QUIET_FROM || d.getHours() < QUIET_UNTIL;

const sound = (name) => { if (isQuiet()) return; try { playSound(`${appHome()}/${ICONS}/sfx-${name}.mp3`); } catch {} };

// Turns Herdr's done/blocked alert sounds off when quiet hours start and back on when they end.
// It only writes settings.json when quiet hours begin or end, so a manual change in between sticks.
async function applyQuietHours(quiet) {
  const path = `${appHome()}/settings.json`;
  const text = await readTextFile(path);
  if (text == null) return;
  const cfg = JSON.parse(text);
  cfg.sounds = cfg.sounds || {};
  if (cfg.sounds.enabled === !quiet) return;
  cfg.sounds.enabled = !quiet;
  await writeTextFile(path, JSON.stringify(cfg, null, 2), text);
}

export default class Quest extends View {
  init(_props, cx) {
    if (props()?.view) return;
    this.prev = new Map();
    this.ready = false;
    this.ticks = 0;
    cx.timer.every(60000, (cx) => this.tick(cx));
    this.tick(cx);
    // Commands: `herdr-app do quest.quests` (or a key in keys.json) opens the quest log;
    // quest.preview-levelup shows the level-up screen without changing the score.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "quests") openOverlay(QUEST_LOG);
        if (c === "preview-levelup") {
          const lv = this.state().level;
          sound("levelup");
          openOverlay({ mod: "quest", kind: "dialog", frame: "none", width: 480, height: 440, props: { view: "levelup", from: lv, to: lv + 1, preview: true } });
        }
        cx.notify();
      }
    });
  }

  state() {
    const s = shared("quest");
    return s && s.v === 1 ? JSON.parse(JSON.stringify(s)) : fresh();
  }

  save(s) { setShared("quest", s); }

  // Every minute: roll quests over at 06:00, look for merged PRs every 10 minutes.
  tick(cx) {
    const s = this.state();
    let dirty = false;
    if (s.quests.day !== questDay()) { s.quests = { day: questDay(), list: pickQuests(questDay()) }; dirty = true; }
    if (dirty) this.save(s);
    const quiet = isQuiet();
    if (quiet !== this.quiet) {
      this.quiet = quiet;
      cx.spawn(async () => { try { await applyQuietHours(quiet); } catch { this.quiet = undefined; } });
    }
    if (this.ticks++ % 10 === 0) cx.spawn(async (cx) => { await this.checkPRs(); cx.notify(); });
    cx.spawn(async (cx) => { await this.readUsage(); cx.notify(); });
    cx.notify();
  }

  // Claude plan usage, saved to ~/.claude/usage-limits.json by the Claude Code status line
  // script (see README) on USAGE_MACHINE. The limits are account-wide, so one machine is enough.
  async readUsage() {
    try {
      const r = await exec("sh", ["-c", 'cat "$HOME/.claude/usage-limits.json"'], { on: USAGE_MACHINE, timeout: 15000 });
      if (r.code === 0 && r.stdout.trim()) this.usage = JSON.parse(r.stdout);
    } catch {}
  }

  async checkPRs() {
    const since = dayKey(new Date(Date.now() - 14 * 86400000));
    const found = [];
    for (const dir of GH_CONFIGS) {
      try {
        const r = await exec("env", [...(dir ? [`GH_CONFIG_DIR=${home()}/${dir}`] : []), "gh", "search", "prs", "--author=@me", "--merged", `--merged-at=>=${since}`, "--json", "number,repository", "--limit", "50"], { timeout: 30000 });
        if (r.code !== 0) continue;
        for (const pr of JSON.parse(r.stdout || "[]")) found.push(`${pr.repository?.nameWithOwner}#${pr.number}`);
      } catch {}
    }
    const s = this.state();
    const seen = new Set(s.prs);
    const fresh = found.filter((k) => !seen.has(k));
    if (!fresh.length && s.prsReady) return;
    s.prs = [...seen, ...fresh].slice(-300);
    // The first look only learns what's already merged; later ones pay out.
    if (s.prsReady) {
      for (const k of fresh) {
        this.award(s, 100, 10, null);
        notify({ title: `PR merged: ${k.split("/").pop()}`, body: "+100 XP · 10 coins", level: "success", icon: `${ICONS}/coin.svg` });
      }
      this.unlock(s, "merge");
      sound("combo");
    }
    s.prsReady = true;
    this.save(s);
  }

  unlock(s, id) {
    if (s.got.includes(id)) return;
    s.got.push(id);
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    notify({ title: `Achievement: ${a.name}`, body: a.how, level: "success", icon: `${ICONS}/trophy.svg`, timeout: 6000 });
    sound("achievement");
  }

  bumpQuest(s, id, by = 1) {
    const q = s.quests.list.find((x) => x.id === id);
    const def = QUEST_POOL.find((x) => x.id === id);
    if (!q || q.n >= def.goal) return;
    q.n = Math.min(def.goal, q.n + by);
    if (q.n >= def.goal) {
      this.award(s, 50, 5, null);
      notify({ title: `Quest complete: ${def.text}`, body: "+50 XP · 5 coins", level: "success", icon: `${ICONS}/scroll.svg` });
      sound("quest");
    }
  }

  award(s, xp, coins, pop) {
    s.xp += xp;
    s.coins += coins;
    if (pop) setShared("quest.pop", { address: pop, text: `+${xp} XP`, coins, at: Date.now() });
    const from = s.level;
    while (s.xp >= need(s.level)) { s.xp -= need(s.level); s.level++; s.coins += 25; }
    if (s.level > from) this.levelUp = { from, to: s.level };
  }

  finish(s, a, now) {
    const combo = now - s.combo.at < COMBO_WINDOW ? Math.min(4, s.combo.n + 1) : 1;
    s.combo = { n: combo, at: now };
    s.total++;
    const firstToday = !s.days.includes(today());
    if (firstToday) s.days = [...s.days, today()].slice(-60);
    this.award(s, 20 * combo, 1, a.address);
    sound(combo > 1 ? "combo" : "coin");
    const hour = new Date(now).getHours();
    this.bumpQuest(s, "ship5");
    if (a.address.includes("/")) this.bumpQuest(s, "remote2");
    if (combo >= 3) this.bumpQuest(s, "combo3");
    if (hour < 10 && hour >= 5) this.bumpQuest(s, "early");
    this.unlock(s, "hello");
    if (s.total >= 100) this.unlock(s, "century");
    if (combo >= 4) this.unlock(s, "combo4");
    if (hour < 5) this.unlock(s, "night");
    if (firstToday) {
      const streak = streakOf(s.days);
      const bonus = { 3: 50, 7: 150, 30: 500 }[streak];
      const key = `${today()}:${streak}`;
      if (bonus && !s.bonus.includes(key)) {
        s.bonus = [...s.bonus, key].slice(-20);
        this.award(s, bonus, 0, null);
        notify({ title: `${streak} day streak!`, body: `+${bonus} XP`, level: "success", icon: `${ICONS}/flame.svg` });
      }
    }
  }

  // Compare every agent with what it was last time; score the changes.
  observe(cx) {
    const list = agents();
    const now = Date.now();
    if (!this.ready) {
      for (const a of list) this.prev.set(a.address, { status: a.status, at: now });
      this.ready = true;
      return;
    }
    let s = null;
    const get = () => (s ??= this.state());
    for (const a of list) {
      const before = this.prev.get(a.address);
      if (!before) { this.prev.set(a.address, { status: a.status, at: now }); continue; }
      if (before.status === a.status) continue;
      if (before.status === "working" && (a.status === "done" || a.status === "idle")) this.finish(get(), a, now);
      if (before.status === "blocked" && a.status === "working") {
        const waited = now - before.at;
        if (waited <= FAST_REPLY) { this.award(get(), 10, 0, a.address); this.bumpQuest(get(), "fast3"); }
        if (waited < 10000) this.unlock(get(), "quick");
      }
      this.prev.set(a.address, { status: a.status, at: now });
    }
    const working = list.filter((a) => a.status === "working");
    const st = shared("quest");
    if (working.length >= 3 && (!st?.got?.includes("herder") || st.quests?.list?.some((q) => q.id === "herd3" && q.n < 1))) { this.unlock(get(), "herder"); this.bumpQuest(get(), "herd3"); }
    if (working.some((a) => a.address.includes("/")) && working.some((a) => !a.address.includes("/")) && !st?.got?.includes("worlds")) this.unlock(get(), "worlds");
    if (s) {
      const up = this.levelUp;
      this.levelUp = null;
      cx.spawn(async () => {
        this.save(s);
        if (up) { sound("levelup"); openOverlay({ mod: "quest", kind: "dialog", frame: "none", width: 480, height: 440, props: { view: "levelup", ...up } }); }
      });
    }
  }

  render(cx) {
    const t = theme();
    const view = props()?.view;
    if (view === "quests") return this.questLog(t);
    if (view === "levelup") return this.levelUpScreen(t);
    this.observe(cx);
    return this.hud(t);
  }

  hud(t) {
    const s = shared("quest")?.v === 1 ? shared("quest") : fresh();
    const pct = Math.max(0, Math.min(100, (s.xp / need(s.level)) * 100));
    const comboOn = s.combo.n >= 2 && Date.now() - s.combo.at < COMBO_WINDOW;
    const done = s.quests.list.filter((q) => q.n >= (QUEST_POOL.find((x) => x.id === q.id)?.goal ?? 1)).length;
    const streak = streakOf(s.days);
    const now = Date.now() / 1000;
    const win = (w) => (w && typeof w.used_percentage === "number" && (!w.resets_at || w.resets_at > now) ? w : null);
    const week = win(this.usage?.seven_day), five = win(this.usage?.five_hour);
    // Mana: what is left of the limit. Blue while plenty remains, gold under 50%, red under 20%.
    const left = (w) => Math.max(0, Math.min(100, Math.round(100 - w.used_percentage)));
    const tone = (pct) => (pct < 20 ? t.blocked : pct < 50 ? t.working : "#4c8dff");
    const when = (sec) => {
      const d = new Date(sec * 1000), hrs = (sec - now) / 3600;
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return hrs < 24 ? hm : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
    };
    return h_flex().id("quest-hud").size_full().px(12).gap(16).items_center().justify_end().bg(t.chrome).border_t(2).border_color(t.border)
      .text_size(13).text_color(t.muted).whitespace_nowrap()
      // Claude plan usage: weekly limit as a bar, the 5-hour window beside it.
      .when(Boolean(week), (el) => el.child(h_flex().id("usage-week").gap(8).items_center()
        .tooltip(`Claude weekly limit: ${left(week)}% left (${Math.round(week.used_percentage)}% used), refills ${when(week.resets_at)}${five ? ` \u00b7 5-hour window: ${left(five)}% left, refills ${when(five.resets_at)}` : ""}`)
        .child(image(`${ICONS}/potion.svg`).w(16).h(19).flex_none())
        .child(div().relative().w(110).h(12).border(2).border_color(t.border).bg(t.canvas)
          .child(div().absolute().left(0).top(0).bottom(0).w(`${left(week)}%`).bg(tone(left(week)))))
        .child(div().text_color(tone(left(week))).child(`${left(week)}%`))))
      .when(Boolean(five), (el) => el.child(h_flex().gap(5).items_center()
        .child(div().text_color(t.foreground).font_bold().child("5H"))
        .child(div().text_color(tone(left(five))).child(`${left(five)}%`))))
      .child(h_flex().gap(8).items_center()
        .child(div().text_color(t.accent).font_bold().child(`LV ${s.level}`))
        .child(div().relative().w(150).h(12).border(2).border_color(t.border).bg(t.canvas)
          .child(div().absolute().left(0).top(0).bottom(0).w(`${pct}%`).bg("#3ee08f")))
        .child(div().child(`${s.xp}/${need(s.level)} XP`)))
      .child(h_flex().gap(6).items_center().child(image(`${ICONS}/coin.svg`).w(16).h(16)).child(div().text_color(t.foreground).child(String(s.coins))))
      .child(h_flex().gap(6).items_center().child(image(`${ICONS}/flame.svg`).w(14).h(18)).child(div().text_color(t.foreground).child(String(streak))).child(div().child("day streak")))
      .when(comboOn, (el) => el.child(div().font_bold().text_color("#ff6ad5").loop("opacity", { from: 0.55, to: 1, period: 700 }).child(`COMBO x${s.combo.n}`)))
      .child(h_flex().id("quest-open").gap(6).items_center().px(8).h(24).border(2).border_color(t.border).bg(t.surface).text_color(t.foreground).cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click(() => openOverlay(QUEST_LOG))
        .child(image(`${ICONS}/scroll.svg`).w(16).h(14)).child(div().child("Quests")).child(div().text_color(t.accent).child(`${done}/${s.quests.list.length}`)));
  }

  questLog(t) {
    const s = shared("quest")?.v === 1 ? shared("quest") : fresh();
    const quests = s.quests.list.map((q) => ({ ...q, def: QUEST_POOL.find((x) => x.id === q.id) })).filter((q) => q.def);
    return v_flex().id("quest-log").size_full().p(14).gap(10).bg(t.surface).border(2).border_color(t.border).text_size(13).text_color(t.foreground)
      .child(h_flex().justify_between().child(div().text_color(t.accent).font_bold().child("DAILY QUESTS")).child(div().text_color(t.dim).child("resets 06:00")))
      .children(quests.map((q) => {
        const done = q.n >= q.def.goal;
        return v_flex().gap(4).pt(6).border_t(2).border_color(t.raised)
          .child(h_flex().justify_between().gap(8)
            .child(div().flex_1().min_w(0).text_color(done ? "#3ee08f" : t.foreground).child(`${done ? "✓ " : ""}${q.def.text}`))
            .child(div().flex_none().text_size(12).text_color(t.accent).child(`${q.n}/${q.def.goal} · +50 XP`)))
          .child(div().relative().h(8).border(2).border_color(t.border).bg(t.canvas)
            .child(div().absolute().left(0).top(0).bottom(0).w(`${Math.round((q.n / q.def.goal) * 100)}%`).bg(done ? "#3ee08f" : "#4cc3ff")));
      }))
      .child(h_flex().pt(10).justify_between().child(div().text_color(t.accent).font_bold().child("TROPHIES")).child(div().text_color(t.dim).child(`${s.got.length}/${ACHIEVEMENTS.length}`)))
      .children(ACHIEVEMENTS.map((a) => {
        const got = s.got.includes(a.id);
        return h_flex().gap(10).items_center()
          .child(image(`${ICONS}/${got ? "trophy" : "trophy-off"}.svg`).w(16).h(16).flex_none())
          .child(div().w(110).flex_none().text_color(got ? t.foreground : t.dim).child(a.name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(a.how));
      }));
  }

  levelUpScreen(t) {
    const p = props();
    const evolved = stageOf(p.to) > stageOf(p.from);
    const robot = (st) => image(st ? `${ICONS}/robot-steel-${st}.svg` : "custom-icons/pixel-robot.svg").w(80).h(80).flex_none();
    return v_flex().id("levelup").size_full().items_center().justify_center().gap(12).bg(t.chrome).border(3).border_color(t.accent)
      .cursor_pointer().on_click(() => closeOverlay(p.overlay))
      .child(div().text_size(12).text_color(t.muted).child("YOUR HERD GREW STRONGER"))
      .child(div().text_size(40).font_bold().text_color(t.accent).child(`LEVEL ${p.to}`))
      .child(div().text_size(16).text_color(t.muted).child(p.preview ? "Preview: your score didn't change" : `+${25 * (p.to - p.from)} coins`))
      .child(h_flex().gap(22).items_center().mt(6)
        .when(evolved, (el) => el.child(robot(stageOf(p.from))).child(div().text_size(20).text_color(t.accent).child("▶")))
        .child(robot(stageOf(p.to))))
      .child(div().text_size(15).text_color(t.muted).child(evolved ? "Your robots evolved" : `Robots evolve at LV ${p.to < 5 ? 5 : p.to < 10 ? 10 : 20}`))
      .child(div().mt(8).text_size(12).text_color(t.dim).child("Click anywhere to continue"));
  }
}
