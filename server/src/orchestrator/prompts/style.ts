export const PROMPT_VERSION = "monterra-style-v2";

/**
 * Fixed style block prepended in code (not restated by the LLM per step) to
 * each step's visual_prompt before it becomes a video-generation prompt.
 * Keeping it centralized avoids per-step drift — the model only has to
 * describe what's specific to that step; the character, setting, and camera
 * stay constant across every clip in a guide.
 */
export const VISUAL_STYLE_PREFIX =
  "Short, calm clip of the same person assembling flat-pack furniture at a well-lit table, filmed straight-on " +
  "at a static three-quarter angle. Consistent character across every clip in this guide: a calm adult in " +
  "simple neutral clothing, face visible, unhurried and focused expression. Consistent room and table in every " +
  "clip — soft daylight, plain warm-cream background matching a printed instruction manual. Smooth, physically " +
  "plausible motion, no jump cuts, no camera movement, no on-screen text or logos.";

/**
 * What makes an assembly video pedagogically good, distilled from the
 * conventions of IKEA's official assembly videos and instructional-video
 * research (Khan-style narration). Output language: Swedish.
 */
export const STYLE_PROMPT = `Du skapar manus för en pedagogisk monteringsvideo på svenska. Följ dessa regler noggrant.

STRUKTUR (som IKEAs officiella monteringsfilmer):
- Börja alltid med en inventering: alla delar och verktyg läggs fram innan första steget.
- Ett moment per steg. Om manualen visar två handlingar i samma bild, dela upp dem.
- Säg målet före handlingen: först VAD steget uppnår, sedan HUR man gör.
- Varningar kommer FÖRE handlingen de skyddar mot, aldrig efter.
- Markera tydligt när ett steg kräver två personer.
- Avsluta med en kort återblick och ett skötselråd.

BERÄTTARRÖST (Khan-stil):
- Korta meningar, högst 14 ord per mening.
- Vägvisning: "Steg 4. Nu ryggstödet."
- Konkret rumsligt språk: "den släta sidan vänds mot väggen".
- Presens och du-tilltal.
- Räkna skruvar högt när manualen anger antal: "fyra av de korta skruvarna – inte de långa".
- Inga utfyllnadsord. Ingen entusiasm-inflation. Lugn, varm, tydlig.

VISUELL REGI:
- Kameran (bildens fokus) ska ligga på fogen som just nu byggs, inte hela möbeln.
- Välj för varje steg vilken manualsida och vilken del av sidan (top/center/bottom/full) som visar momentet bäst.

TEMPO:
- 15–35 sekunder per steg. Max 20 steg – slå ihop triviala moment.
- narration_script per steg: högst 2 meningar som täcker mål, handling och kontroll.

KÄLLTROHET:
- Hitta aldrig på ett steg, antal, verktyg eller fäste som inte syns i manualen.
- Om ett antal är otydligt: säg "skruvarna som visas", aldrig en gissad siffra.
- Om manualsidan är tvetydig: sätt needs_review=true. Steget visas då med bild och text utan berättarröst.
- Sista stegets narration_script avslutas exakt med "Klart. Snyggt jobbat."

VISUAL_PROMPT (engelska, inte svenska — det här är en videogenereringsprompt, inte användartext):
- En fast karaktärs- och miljöbeskrivning läggs till i kod (samma för alla steg i alla guider) — skriv INTE om den här.
- Beskriv bara handlingen i just detta steg, som rörelse snarare än en stillbild, 1-2 meningar: vad personen plockar upp, hur delarna hålls och riktas, rörelsen som monterar dem, var de hamnar. Exempel: "picks up both side panels, aligns the pre-drilled holes, and presses the dowels in with steady pressure until they sit flush."
- Namnge exakt de delar/verktyg som anges i stegets parts/tools — hitta aldrig på en del, ett antal eller en rörelse som inte visas i manualen.
- En sammanhängande handling per steg, inget persongalleri, ingen text eller logga i bilden.

Allt användarvänt innehåll (titlar, instruktioner, varningar, berättarmanus) skrivs på svenska. Delar och verktyg namnges på svenska. visual_prompt är internt och skrivs på engelska.`;

export function productPrompt(opts: {
  productName: string;
  itemNumber: string;
  category: string | null;
  pageCount: number;
  scrapedNotes?: string | null;
}): string {
  return `PRODUKT: ${opts.productName} (artikelnummer ${opts.itemNumber}${opts.category ? `, kategori ${opts.category}` : ""}).
Manualen har ${opts.pageCount} sidor och visas som bilder nedan, i ordning (sida 1 först).
IKEA-manualer är nästan ordlösa – läs diagrammen noga: skruvtyper, antal, riktningspilar och varningssymboler.
${opts.scrapedNotes ? `Anteckningar från produktsidan: ${opts.scrapedNotes}` : ""}
Skapa nu monteringsguiden genom att anropa write_step_to_db för varje steg (gärna alla i samma svar). Välj för varje steg manual_pages och focus (sida + region) för bästa bildutsnitt, och skriv visual_prompt på engelska enligt VISUAL_PROMPT-reglerna ovan.`;
}
