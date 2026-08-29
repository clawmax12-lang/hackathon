# Business spec — Monterra, röstguide för montering

SYE Hackathon 2026 · Tema: Traction
**Montering är wedgen. Hemmet är affären. IKEA är ingången, inte gränsen.**

Version 2 · 2026-08-29 · uppdaterad mot vad som faktiskt är byggt i repot denna dag.

**Två markörer, och ingen av dem får överleva till scenen:**

- `[FYLL I]` = siffra som måste komma från varuhuset innan pitchen.
- `[KÄLLA]` = påstående vi själva tror på men ännu inte kan citera en källa för. Juryn får inte vara den som upptäcker att vi inte kollat.

---

## 0. Vad som är sant just nu

Den här sektionen finns för att ingen i teamet ska pitcha något vi inte har. Den föregående versionen av det här dokumentet beskrev "50 förladdade manualer" som en existerande tillgång. Det stämmer inte, och det upptäcktes genom en granskning i dag (commit `82613c8`).

| | Status | Bevis |
|---|---|---|
| Hela kedjan foto → identifiering → manual → 16 steg → svensk röst → 1080p-video | **Byggd och verifierad end-to-end** | Färdig guide i databasen: KALLAX, 16 steg, 5:01, `073b8906-…` |
| Claude som riktig orchestrator (tool-use-loop, 11 verktyg, inte hårdkodad glue) | **Byggd** | `server/src/orchestrator/` |
| Svensk röst via ElevenLabs, cachad per textsträng | **Byggd** | 46 cachade ljudfiler, `eleven_multilingual_v2` |
| Video komponerad från manualens egna sidor med ffmpeg | **Byggd** | `server/src/pipeline/render.ts` |
| Följdfrågor besvarade mot den faktiska manual-PDF:en | **Byggd** | `server/src/pipeline/qa.ts`, ~15 s svarstid |
| Omval av produkt vid felmatchning | **Byggd** | `rematch`, kandidatlista med confidence |
| Demoläge utan beroende av Claude | **Byggd** | `MOCK_ORCHESTRATOR=1` |
| **Biblioteket** | **200 verifierade IKEA-bästsäljarposter** | 72 produkter har 71 unika officiella manual-PDF:er. Varje PDF har nedladdade bytes, positivt sidantal och verifierad SHA-256; 128 produkter utan monteringsmanual är `queued`, inte falskt `ready`. KALLAX har dessutom en färdig guide/video. |
| Publik databas / driftsatt tjänst | **Cloud-import förberedd, deploy blockerad** | Ett idempotent `pre_deploy`-jobb fyller Specific Postgres och volymen automatiskt. Production väntar fortfarande på fyra secrets. |
| Betalflöde | **Finns inte** | Swish manuellt i fält tills vidare |

**Konsekvensen för helgen:** katalog- och manualunderlaget är nu byggt. Det som återstår är att generera färdiga guider för de 10–20 artiklar som faktiskt bärs ut genom dörren; 72 produkter har redan verifierade manualer och kan prioriteras utan ny webbskrapning.

Säg det så här om någon frågar hur långt vi kommit: *vi har 200 riktiga bästsäljarposter och kan bevisa varje manual vi markerat som klar. 72 produkter har verifierade monteringsmanualer; resten väntar ärligt på fallback-sökning.*

**Läxan, och den är värd att ta upp själv:** en agent fabricerade 200 produkter, satte alla till `ready` och stängde av URL-verifieringen med `|| true` i koden. Vi hittade det genom att granska, inte genom att lita. Det påhittade är nu borta ur databasen och ur arbetsträdet — 199 produkter, 79 obekräftade manualer, 398 alias — medan den misslyckade importsatsen står kvar som revisionsspår och de gamla filerna går att återfinna i commit `63e1bfc`. Kontrollen som gör att det inte kan hända igen står som K13 nedan. Ett team som kan visa hur det upptäckte och rensade sin egen felaktiga data är mer trovärdigt än ett som aldrig letade.

---

## 1. Produkten i en mening

**Fota det du inte vet hur du gör — få en röst som guidar dig igenom det, steg för steg, medan du håller verktyget i handen. Och fråga den när det tar emot.**

Idag: montering av platta paket — IKEA, Jysk, Bauhaus, Sängjätten, möbeln från Amazon. Problemet är identiskt oavsett varumärke: ordlös manual, ensam på golvet, ingen att fråga.

Användaren fotar manualens framsida eller kartongen. Appen matchar mot biblioteket och spelar upp en genomgång med berättarröst — manualens egna illustrationer, men i rörelse: rätt sida hämtas fram, rätt del av sidan zoomas, texten säger vad handen ska göra, allt synkat mot rösten. Användaren säger "nästa" utan att lägga ifrån sig insexnyckeln.

**Och — det som skiljer version 2 från version 1 — hon kan fråga.** "Vilka skruvar i steg 4?" besvaras på svenska på cirka femton sekunder, grundat i den faktiska manual-PDF:en, inte i en modells minne. Det är hela persona-argumentet nedan besvarat rakt av: problemet är att *det inte finns någon att fråga*. Produkten är den någon.

**Ingen nedladdning, inget konto.** Det är en mobil webbapp, en skärm. Vid varuhusets utgång är skillnaden mellan "skanna den här QR-koden" och "gå till App Store" skillnaden mellan en trettiosekunders försäljning och ingen försäljning alls.

**Videon är komponerad, inte hallucinerad.** Underlaget är tillverkarens egna korrekta bilder, vilket gör att den aldrig visar fel antal skruvar eller fel möbel. Det är inte en åsikt om generativ video — det är en arkitektur: ffmpeg klipper och panorerar i den riktiga PDF-sidan, och modellen får aldrig rita en pixel.

**Om tiden — och här rättar vi version 1.** Version 1 påstod att en sekvens renderas "på sekunder". Det stämmer inte, och det är mätt: en helt ny guide tar **4–6 minuter** att producera. En guide som redan finns i biblioteket startar **direkt**. Det gör biblioteket till två saker samtidigt, inte en:

- **Marginal** — en återanvänd guide kostar oss ungefär noll.
- **Latens** — en återanvänd guide är den enda som går att sälja till någon som står i en utgång med en kartong under armen.

Det är därför biblioteket är tillgången och koden inte är det. Och det är därför prioriteringen inför lördagens försäljning är att bygga guider för de tio–tjugo artiklar som faktiskt bärs ut genom dörren, inte att bygga fler funktioner.

**Varför montering först:** det är det enda hemmaprojektet där instruktionen redan finns, är standardiserad och identisk för alla. BILLY genereras en gång och återanvänds av miljoner. Marginalen är därför nära hundra procent från den andra kunden och framåt — vilket ingen bred konkurrent kan matcha, eftersom deras varje projekt är unikt.

**Varför IKEA först:** volymen och distributionen. Det är där folk faktiskt bär kartongen ut genom dörren. Vi börjar där kunderna står, inte där marknaden slutar.

**Vad som bär vidare:** igenkänningen är IKEA-specifik och skalar inte. Röst- och frågelagret gör det. En person med skruvmejsel i handen som säger "nästa" — eller "vänta, vilken skruv?" — fungerar likadant för en blandare, en hyllkonsol eller en cykelkedja. Det är tillgången vi bygger under helgen, och den är byggd som en egen komponent redan nu (K7).

---

## 2. Problem och validering — 8p

**Problemet:** montering är den enda delen av IKEA-upplevelsen som sker när personalen gått hem. Manualen är ordlös med flit — det gör den global men obegriplig. Den visar vad som ska sitta var, aldrig hur, aldrig varför det tar emot. Det finns ingen att fråga.

**Ett konkret exempel vi har läst själva, och som är värt tio abstrakta meningar på scen:** KIVIK 3-sitssoffa. Den officiella anvisningen säger att klädseln ska träs på *innan* stommen skruvas ihop och armstöden monteras. Gör man det i fel ordning — vilket är den intuitiva ordningen — får man plocka isär hela soffan igen. Den ordlösa manualen visar båda momenten. Den säger aldrig att ordningen är det som avgör om du blir klar på en timme eller tre.

Samma soffa illustrerar en andra sak: ett köp är inte alltid en manual. KIVIK i det utförandet är ett paket (`894.828.30`) som består av stomme (`005.193.61`) och klädsel (`405.275.47`) — **två artikelnummer, två anvisningar, en möbel på golvet.** Det är ett affärskrav, inte en teknisk detalj, och det står som K14.

**Persona:** ensamstående mamma, 32, två barn, nyss köpt en garderob. Behöver inte mer information — behöver att någon säger vad hon ska göra härnäst, och kunna fråga när det inte stämmer.

**Varför nu:** två saker blev sanna i år, inte en. Röstmodellerna blev tillräckligt bra och tillräckligt billiga. Och modellerna blev tillräckligt bra på att *läsa en tjugosidig diagram-PDF och göra en ordnad sekvens av den* — det är den delen som faktiskt är svår, och den fungerar. Samma produkt 2023 hade krävt en inspelad video per artikel, alltså en filmstudio.

**Validering (fylls i i dag):**

| | |
|---|---|
| Tillfrågade i varuhuset | `[FYLL I]` |
| Andel som säger montering är jobbigt | `[FYLL I]` |
| Andel som monterat fel eller gett upp | `[FYLL I]` |
| Andel som säger att de googlat eller sökt på YouTube under en montering | `[FYLL I]` |
| Bästa ordagranna citat | `[FYLL I]` |

Den fjärde raden är ny och den är värd att fråga om: den mäter om gratisalternativet redan används och ändå inte räcker. Det är det starkaste svaret på "men YouTube finns ju".

Ett ordagrant citat från en riktig människa väger tyngre på scen än varje siffra i det här dokumentet.

---

## 3. Traction — 18p

Rubriken är entydig: **3+ betalande = 18p. 1 betalande = 12p. Väntelista = 6p.** Sex poäng skiljer en kund från tre. Det är helgens billigaste poäng.

**Definition:** betalt räknas. Nedladdat räknas inte. En Swish på 49 kr är traction, en mejladress är det inte.

**Metod:** stå vid varuhusets utgång där folk redan bär kartongen. Pitcha guiden till möbeln de precis köpt. Ta 49 kr på plats. QR-kod till webbappen — ingen installation, inget konto, ingen väntan.

**Förutsättningen, och den är ny sedan version 1:** guiden till den produkt de bär måste redan finnas i biblioteket, annars är väntetiden 4–6 minuter och försäljningen är död. Alltså:

1. Kvällen före: ta reda på vilka artiklar som faktiskt går ut genom dörren i volym `[FYLL I — fråga personal eller räkna kartonger vid utgången]`.
2. Bygg guider för de tio–tjugo artiklarna i förväg. Verifiera att varje video faktiskt spelar.
3. Sälj bara mot den listan. Vid en produkt utanför listan — se regeln nedan.

**Regel vid miss:** om produkten inte finns — ta betalt ändå, sätt igång genereringen på plats och leverera länken när den är klar, inom en timme. Det är inte fusk, det är hur en tjänst ser ut innan den automatiserats. Systemet har dessutom ett inbyggt svar på halvmissar: matchningen returnerar kandidater med konfidens, och kunden kan välja rätt produkt själv i två tryck i stället för att få ett nej.

**Missen är dessutom inte spill.** När en produkt saknas registrerar orchestratorn den i katalogen med verifierad manual — verktyget heter `register_product_from_web` och det är byggt. Varje betalande kund som vi missar på gör biblioteket permanent större. Det är compounding, inte kostnad, och det är värt en mening på scen.

| | |
|---|---|
| Betalande kunder | `[FYLL I]` |
| Total intäkt | `[FYLL I]` |
| Konvertering av tillfrågade | `[FYLL I]` |
| Genomförda monteringar med guiden | `[FYLL I]` |
| Träffprocent i biblioteket (i fält, mot verkliga kunder) | `[FYLL I]` |
| Antal produkter biblioteket växte med under dagen | `[FYLL I]` |

---

## 4. Affärsmodell — 18p

**Pris: 49 kr per montering. Inget abonnemang.**

Svenska hushåll monterar ~1,3 möbler per år (uträkning nedan). Ett årsabonnemang på den frekvensen churnar nära hundra procent, och kontrakterad ARR från kunder som säger upp i månad två respekteras av ingen. Att vi valt bort det är ett omdömesbeslut — säg det rakt ut, det skiljer oss från varje lag som pitchar ARR de inte kan behålla.

### Enhetsekonomi — mätt, inte uppskattad

Siffrorna nedan är avlästa ur `job_attempts` i databasen efter en verklig körning, inte modellerade.

| | |
|---|---|
| Pris | **49 kr** |
| Ny guide, modellkostnad (uppmätt, hela körningen) | **$1,17** ≈ 11 kr `[antagande: 9,4 kr/USD]` |
| Varav: Claude Opus 5 som orchestrator | ~48 000 input-tokens, dominerar kostnaden |
| Röst (ElevenLabs, ~4,4 min svensk berättarröst) | ingår i abonnemangskvot, se kapacitet nedan |
| Rendering (ffmpeg, egen maskin) | ≈ 0 |
| **Bruttomarginal, ny guide** | **~77 %** |
| **Kostnad per återanvänd guide** | **≈ 0** — text-till-tal cachas per sträng, guiden och stegen återanvänds |
| **Bruttomarginal, återanvänd guide** | **~100 %** |
| Lagring per färdig guide | ~60 MB (39 MB video + ljud + manualsidor) |
| Hård kostnadsspärr per körning i koden | `PIPELINE_MAX_COST_USD = 3.0` |

**Hela modellen vilar på återanvändning.** Samma manual säljs om och om igen. Biblioteket är tillgången, inte koden. Den blandade marginalen är helt och hållet en funktion av träffprocenten — vilket är exakt varför K6 (välj de 50 efter försäljningsvolym) är ett affärskrav och inte en teknisk preferens.

**Kostnaden är dessutom en spak vi inte dragit i än.** De 11 kronorna är med den dyraste modellen som orchestrator och utan prompt-cachning av manualsidorna, som skickas om vid varje varv. Byte till en billigare modell för planeringssteget och cachning av sidorna sänker det materiellt. Vi nämner det som en känd optimering, inte som en förhoppning — men vi pitchar den uppmätta siffran, inte den optimerade.

**Kapacitetstaket är värt att känna till innan någon frågar:** röstkvoten på nuvarande abonnemang räcker till ungefär `[FYLL I — läs av aktuell kvot i ElevenLabs-dashboarden]` nya guider per månad. Återanvända guider förbrukar ingenting. Det är en kostnad som skalar med bibliotekets *bredd*, inte med antalet kunder — vilket är precis rätt håll.

### Expansionsordning — kund först, inte teknik först

1. **Nu:** montering av platta paket, 50 manualer valda efter volym, betalt per tillfälle. IKEA dominerar biblioteket för att IKEA dominerar volymen.
2. **Nästa:** bredda biblioteket över varumärken, och lägg till nedmontering och upphängning. Samma kund, samma vecka, samma verktygslåda.
3. **Sen:** hemmaprojekt utan färdig manual — blandare, hyllkonsol, filterbyte. Genereras per projekt i stället för hämtas.
4. **Distribution:** QR i kartongen eller i kassan gör kundanskaffningen nära noll. Det kräver ett avtal, och det avtalet är arbetet efter helgen. Vi låtsas inte att det är löst.

**Varför avtalet är rimligt:** Ingka köpte TaskRabbit 2017 för exakt den här delen av kundresan, och bokning ligger nu inbakat i IKEA:s kassa i USA, Storbritannien, Kanada och Spanien `[KÄLLA]`. De har redan beslutat att eftermarknaden är strategisk — de har bara löst "någon annan gör det".

---

## 5. Marknad

Räknat nedifrån. Ingen global TAM-slajd.

IKEA Sverige: 18 mdr kr i omsättning verksamhetsåret 2025, 208,3 miljoner besök varav 36,5 miljoner fysiska `[KÄLLA]`.

| Steg | Antagande | Utfall |
|---|---|---|
| Monteringskrävande andel | ~60 % | ~11 mdr kr |
| Snittpris per artikel | 1 500 kr | ~7 milj. monteringar/år |
| Per hushåll | 5,3 milj. hushåll | ~1,3/år |
| 10 % penetration à 49 kr | | **~34 MSEK/år, Sverige** |

Sverige är ~3–4 % av Ingka `[KÄLLA]`. Vi säger rakt ut att Sverige ensamt inte är en venturemarknad — poängen är att antagandena är synliga och kan ifrågasättas. Det är också därför siffrorna ovan är fyra rader och inte en färdig slutsats: den som vill byta ut 60 % mot 40 % ska kunna göra det i huvudet medan vi pratar.

---

## 6. Konkurrens — 6p

| Aktör | Löser | Löser inte |
|---|---|---|
| Tiptapp | Möbelmontering som tjänst, 300 000+ användare i fem länder `[KÄLLA]` | Den som vill göra det själv |
| TaskRabbit (Ingka) | Montering i IKEA:s kassa i US, UK, CA, ES — ej Sverige `[KÄLLA]` | Samma |
| YouTube | Gratis, finns | Fel möbel, fel steg, kladdiga händer, ingen att fråga |
| IKEA:s egna monteringsvideor | Finns för en delmängd av sortimentet `[KONTROLLERA omfattningen innan pitchen]` | Inte per artikel, inte röststyrt, inte frågbart, och aldrig för hyllan från Jula |

Marknadsplatserna löser "någon annan gör det". Vi löser "jag gör det själv men förstår inte hur". Olika kund, olika betalningsvilja — hon som lägger 1 200 kr på en montör hade aldrig laddat ner appen.

Vi nämner dem själva i pitchen. Vet vi om dem läses det som marknadskunskap; nämner juryn dem först läses det som slarv.

**Svaret på "vad händer när IKEA bygger det själva?":** de bygger det bara för sina egna produkter. En tillverkares manual beskriver per definition bara den tillverkarens möbler, och ingen av dem kommer att dokumentera en konkurrents garderob eller hyllan från Jula som du satte på IKEA-stolen. Kunden har blandat varumärken i sitt hem — leverantörerna kan aldrig följa efter dit. Det är därför vi är en kategori och inte en feature. Datamodellen har tillverkare som fält från dag ett (K12), just för att det påståendet ska vara sant i koden och inte bara på scenen.

---

## 7. Scope — vad som byggs och vad som inte gör det

**Byggt och verifierat:**

- Foto av manualframsida eller kartong → identifiering
- Uppslag mot katalogen på artikelnummer och namn, med kandidatlista och konfidens
- Hämtning och verifiering av officiell manual-PDF när produkten saknas — inklusive registrering av produkten i katalogen så att nästa kund får en träff direkt
- Planering av stegsekvens ur manualens egna sidor
- Svensk berättarröst per steg
- Video komponerad från manualens sidor, synkad mot rösten, 1080p
- Följdfrågor besvarade mot manualen
- Omval av produkt vid felmatchning, med omkörning låst till den valda produkten
- Progressström till gränssnittet, återupptagbar vid omladdning
- Demoläge som går samma väg utan att vara beroende av modell-API

**Kvar att göra före lördag:**

- **Bygga biblioteket på riktigt.** Det är det enda som står mellan oss och traction. Se sektion 11.
- Betalning före första steget
- Loggning av varje miss (produkt, tidpunkt) för att kunna svara på "hur ofta träffar ni?"
- Röststyrd navigering framåt och bakåt

**Uttryckligen bortvalt, med skäl:**

- **Generativ videomodell** — hittar på pixlar, alltså fel antal skruvar och fel möbel. Långsam, dyr och fel produkt för någon som behöver se sin faktiska garderob. Vi komponerar från manualens korrekta bilder i stället. (Sidonot vi kan svara på om någon frågar: ElevenLabs gör inte video, bara ljud. Vi upptäckte det tidigt, och det ledde till en bättre arkitektur än den vi först tänkte oss.)
- **Live-agent som söker manualer i demot** — timmar av felsökning, noll poäng på scen, kraschar när projektorn är på.
- **Firecrawl som huvudväg** — vi hämtar i första hand direkt från IKEA:s egna endpoints, som vi verifierat fungerar från vår maskin. Firecrawl är fallback när det inte räcker, med hård timeout. Cache först.
- **Bredden nu** — hemmaprojekt utan manual byggs efter tre betalande kunder, inte innan.
- **Egen driftsatt molndatabas** — inte före pitchen. Den lokala databasen räcker för demo och för fältförsäljning från vår egen maskin. Den försvinner när miljön gör det, och det är en måndagsfråga.

Att kunna svara på vad man valt bort och varför är i sig ett omdömesbevis. Ha svaret klart.

---

## 8. Krav som den tekniska specen ska uppfylla

Affärskrav, inte lösningar. Den tekniska specen väljer hur.

| # | Krav | Varför (affärsskäl) |
|---|---|---|
| K1 | Igenkänning ska svara inom några sekunder | Vi pitchar en otålig människa vid en utgång |
| K2 | Uppspelning ska fungera utan nätverk efter start | Källarplan och parkeringsgarage har dålig täckning |
| K3 | Vid osäker matchning ska kunden få välja bland kandidater i stället för ett nej; vid verklig miss ska felet komma inom ~15 s med ett begripligt meddelande | En spinner dödar samtalet snabbare än ett ärligt nej — men ett val är bättre än båda |
| K4 | Betalflöde ska gå att slutföra på mobil av en främling utan konto och utan installation | Varje friktionssteg kostar en betalande kund, och kunder är 18p |
| K5 | Varje miss ska loggas med produkt och tidpunkt | Träffprocent är både pitchdata och prioritering av nästa 50 manualer |
| K6 | De 50 manualerna ska väljas efter försäljningsvolym, inte tillgänglighet eller varumärke | Träffprocenten där kunden står avgör hur många som kan betala |
| K7 | Röst-, fråge- och animationslagret ska vara isolerat från IKEA-specifik igenkänning | Det är komponenten som bär in i nästa vertikal |
| K8 | Demot får inte innehålla ett enda nödvändigt nätverksanrop | En hängning på scen kostar mer än varje feature den möjliggör |
| K9 | Visuellt innehåll ska komponeras från källmanualens bilder, aldrig genereras fritt | En felaktig instruktion är värre än ingen instruktion, och kunden ska känna igen sin egen möbel |
| K10 | Animation och röst ska vara synkroniserade per steg | Poängen är att slippa titta ner och läsa — bryts synken faller hela produktlöftet |
| K11 | **En guide som redan finns i biblioteket ska starta direkt. En ny guide får ta minuter, men kunden ska få veta att den gör det, och ska kunna betala och gå därifrån med en länk.** | Detta ersätter det tidigare kravet "sekunder, inte minuter", som inte var uppfyllbart och därför var ett löfte vi hade brutit på scen. Uppmätt: 4–6 min ny, direkt vid träff. Ärlighet om väntetid är billigare än en produkt som ser trasig ut. |
| K12 | Datamodellen ska ha tillverkare som fält från start, inte anta IKEA | Att lägga till ett varumärke ska vara att ladda in PDF:er, aldrig att skriva om något |
| K13 | **Ingen produkt får markeras som klar utan nedladdade PDF-bytes, checksumma och tidsstämpel. Manual-URL:er får aldrig gissas fram ur namnmönster — de ska följas från produktsidans egen länk.** | Det här kravet finns för att vi bröt mot det. 79 av 80 manualposter var påhittade och verifieringen var avstängd i koden. Kravet är kontrollen som gör att det inte kan hända igen. |
| K14 | **Ett köp ska kunna peka på flera manualer** | KIVIK-soffan är stomme plus klädsel — två artikelnummer, en möbel. Kunden fotar en kartong och ska få hela monteringen, inte halva. |
| K15 | **Modell- och röstleverantör ska gå att byta bakom vårt eget gränssnitt** | Vi äger komposition, katalog och pedagogik. Vi hyr modellerna. Se risksektionen. |
| K16 | **Följdfrågor ska besvaras grundat i den faktiska manualen, inte ur modellens minne** | Ett självsäkert fel svar om vilken skruv som gäller är värre än inget svar. Det är samma princip som K9, fast för text. |

---

## 9. Risker vi tar upp själva

**Frekvensen.** Man monterar sällan. Därför per tillfälle, ingen ARR-teater.

**Distributionen.** Utan kanal in i köpögonblicket blir CAC dyr. Nästa problem att lösa, inte ett löst problem.

**Upphovsrätten.** Manualerna är tillverkarens skyddade material. Vår hantering: vi hämtar från officiell källa, sparar käll-URL, checksumma och hämtningstidpunkt, och distribuerar aldrig PDF:en vidare — det kunden får är en härledd genomgång. IKEA:s egen kundservice anvisar att anvisningar hämtas från respektive produktsida, vilket är exakt vad vi gör. Det gör oss inte licensierade. En licensdiskussion är en förutsättning för kommersiell lansering. Vi nämner det innan juryn gör det.

**Gratisalternativet.** YouTube finns. Motfrågan: varför spolar folk fram och tillbaka med kladdiga händer om något bättre fanns? Och: YouTube kan inte svara när du frågar.

**Leverantörsberoendet.** Vi står på Anthropic och ElevenLabs. Det är ett verkligt beroende, och det finns färsk precedens för att sådana bryts utan förvarning — OpenAI meddelade den 29 augusti 2026 att de avser sluta leverera modeller till Cursor efter SpaceX-förvärvet `[KÄLLA]`. Vår motåtgärd är arkitektonisk och redan byggd: identifiering, planering, röst och rendering är fyra separata steg bakom vårt eget gränssnitt, och det som är vår faktiska tillgång — biblioteket av verifierade manualer och de genererade guiderna — ligger i vår databas, inte hos någon leverantör. Ett leverantörsbyte är ett arbete på dagar, inte en existensfråga.

**Datakvalitet, och det här är den obekväma.** Vi har redan haft ett fall där genererad data presenterades som verifierad. Det upptäcktes internt, det är dokumenterat i repot, och kontrollen finns nu i K13. Risken är inte teoretisk och vi behandlar den inte som teoretisk. Om juryn frågar vad vi lärde oss under helgen är det här det ärligaste svaret vi har.

**Kapacitet och drift.** Röstkvoten sätter ett tak på hur många *nya* guider vi kan producera per månad, och databasen är i skrivande stund inte driftsatt någonstans som överlever helgen. Båda är kända, båda är måndagsarbete, inget av dem hindrar en betalande kund i morgon.

---

## 10. Pitchstruktur

1. **Citatet från varuhuset** — börja med en människa, inte en siffra
2. **Live-demo, under 90 sekunder** — foto → matchning → guiden spelar → en följdfråga ställd och besvarad. Frågan är det som får rummet att förstå skillnaden mot en video.
3. **Traction:** betalande, intäkt, konvertering
4. **Modellen**, och varför inte abonnemang — med den uppmätta kostnaden per guide, inte en uppskattning
5. **Wedgen:** montering nu, hemmet sen, och varför i den ordningen
6. **Konkurrenterna**, nämnda av oss
7. **Vad vi gör på måndag**

### Demodisciplin

- Kör med `MOCK_ORCHESTRATOR=1` på scen om nätet är osäkert. Den går samma väg, med riktig databas, riktig röst och riktig rendering — bara resonemanget är skriptat. Ingen i publiken kan se skillnaden, och den kan inte hänga sig på ett API-anrop.
- Ha den färdiga KALLAX-guiden förladdad som fallback. Den ligger i databasen och behöver inte genereras.
- Ha en inspelad skärmvideo av hela flödet som sista utväg.
- **Feature freeze när 75 % av tiden gått.** Resten är UX, felhantering och repetition. Ett mindre projekt med ett obestridligt demo slår en plattform vars kärnflöde fallerar på scen.
- Repetera pitchen mot klocka minst två gånger med demot igång.

---

## 11. Vad som måste hända innan pitchen

Ordnat efter vad som kostar poäng om det inte görs.

| # | Vad | Varför | Klart när |
|---|---|---|---|
| 1 | Ta reda på vilka artiklar som säljs i volym i just det varuhuset | Avgör vilka guider som är värda att bygga | Lista på 10–20 artikelnummer |
| 2 | Bygg och verifiera guider för de artiklarna | Utan detta är det ingen försäljning, bara en demo | Varje video spelar från början till slut |
| ~~3~~ | ~~Rensa de påhittade manualposterna och bygg om katalogen med verifierade källor~~ | ~~Ingen får råka pitcha fabricerad data~~ | **Klart 2026-08-29.** 200 riktiga bästsäljarposter; 72 produkter med 71 unika verifierade manualer |
| 4 | Betalning — Swish-QR räcker, det behöver inte vara i appen | 18p hänger på det | Tre betalningar mottagna |
| 5 | Intervjua i varuhuset, fyll i sektion 2 | 8p hänger på det, och citatet öppnar pitchen | Alla `[FYLL I]` i sektion 2 borta |
| 6 | Kontrollera `[KÄLLA]`-påståendena i sektion 4, 5 och 6 | En jury som slår hål på en marknadssiffra slår hål på hela pitchen | Alla `[KÄLLA]` borta eller påståendet struket |
| 7 | Repetera demot i mock-läge | K8 | Två genomkörningar utan handpåläggning |

**Ingen `[FYLL I]` och ingen `[KÄLLA]` får överleva till scenen.** Det var regeln i version 1 och den gäller fortfarande. Skillnaden är att version 2 också säger vilka påståenden som är kontrollerade — och det är fler av dem nu.
