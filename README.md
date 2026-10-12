# Plandot

Turn callouts and symbols on a plan into pins, ready to import, with every pin placed where it belongs.

**Live app:** the link is in the *About* box at the top right of this page. No install, no sign-in.

## What it does

You tell Plandot which text matters ("A1, A2 and A3 are socket outlets"), or box one example of a symbol. It finds every match in the drawing PDF, follows each callout's leader line to the dot it points at, shows the pins on the sheet so you can check them, and fills in your project's import template, ready to import.

```
drawing.pdf  +  import template.xlsx  +  rules   ->   check the pins   ->   import file (.xlsx)
                                                                       ->   marked-up PDF, pin image
```

![The Plandot page with 13 pins on a made-up floor plan](docs/screenshot.png)

## Use it

1. Drop the **drawing PDF**.
2. Drop the **import template** (.xlsx) downloaded from your project.
3. Type the **plan name** exactly as it appears in the project.
4. Add **rules**. Each has a *Look for* choice (*Text callout* or *Draw box*), the *Text to find*, a *Pin title*, where the *Pin placed on* goes (*On the location* or *On the callout*), and any other column to fill (category, assignee, a custom attribute).
5. Untick any pin you don't want, look at **Preview what will be exported**, then **Download import file** and import it.

**Try it without your own files:** press *Try with a sample drawing* on the empty page. It loads a made-up drawing, template and rules in one click (needs the page opened from its web address, not as a file). The same three files are in `samples/`.

## Pin titles

Under each rule's *Pin title* are buttons: **Callout text**, **Room**, **Room in brackets** and **Number**. Click one to drop it into the title at the cursor (they are the fill-ins `{tag}`, `{room}`, `{room_label}` and `{n}`; you can also type them). A line underneath shows the result: *First pin: Install socket A1 (Room 1-101)*, from the first real match, or an example until something is found. If the title uses the room but no room label pattern is set, it says so.

## Zoom

The drawing sits in a window of its own, next to a left panel that never changes size. Zoom with the **+ / −** buttons, **Ctrl (or ⌘) + scroll**, a trackpad pinch, or the **+ − 0** keys once the drawing has focus. **Fit** (or 0) shows the whole sheet again. Scroll or drag to move around. Only the part you can see is drawn at full sharpness, so lines stay crisp however far you zoom, and the percentage rulers get finer as you go. Click a row in the pin list to jump to that pin.

## Setup files, undo and checking before you download

- **Save setup / Open setup** keep your rules, the plan name and the room settings in a small file, so you can reuse them on other drawings or hand them to a customer.
- **Undo / Redo** (above the rules, or Ctrl/⌘ + Z outside a text box) step back through rule changes, including removing a rule.
- **Preview what will be exported** shows a sentence ("13 pins will go onto plan …") and the first rows of the file.
- A page with **no selectable text** (a scan or a photo of a drawing) now says so plainly, and each text rule says it too.
- A password-protected PDF, a file that isn't a PDF, a wrong file dropped on the page, and a setup file that isn't one all get a plain message.

## Pins go on the dot, not the label

A callout is a tag inside a diamond, circle or hexagon, with a leader line running to a solid dot on the thing it labels. The pin belongs on the dot, so that is where the pin goes.

- Leaders with elbows, or drawn in several pieces, are followed to the end.
- A callout with **two leaders gets two pins**. Untick one if you only want one.
- A callout with **no leader keeps its pin on the callout**, and a leader that ends without a dot gets the end of the leader. The pin table's *Pinned on* column and each rule's status line say which happened, so nothing is silently guessed.
- Arrowheads and square blocks are not mistaken for dots, and each callout gets its own dot, not simply the nearest one.
- Each rule can instead pin on the callout text.

Positions are written as percentages from the top-left corner of the sheet, which is how the importer reads them. *Check pin positions first* (under Download) makes nine test pins on the 10%, 50% and 90% grid lines so you can confirm that on your own account in a minute.

## Pin a symbol, not just a callout

Some things have no tag: patio doors, sockets, fire extinguishers. Set a rule to **Look for: Draw box**, drag a box around one example on the sheet, and Plandot finds every other copy of it and puts a pin on each.

- Copies that are **turned or mirrored** are found too. Tick **Also find copies drawn bigger or smaller** to find copies from half to double the size of the one you boxed (the pin lands on the same spot, scaled with it). It takes longer, so it is off by default.
- Draw the box so it fully contains the symbol. Lines that cross the box edge, such as the wall either side of a door, are left out.
- Click the little picture of the symbol to choose **where the pin goes** on it. It lands on the same spot of every copy, however it is turned.
- The **match slider** (Loose to Exact) sets how closely a copy must resemble yours. If some are missed, move towards Loose; if wrong things are picked up, towards Exact.
- The pin title can use the rule's name (the **Symbol name** button) and the number. The rule, its symbol and its settings are saved in the setup file.

It matches the drawing's line work, so like the leader dots it needs a vector PDF from CAD or Revit, not a scan. To try it, drop `samples/sample-symbols.pdf` and box one of the patio doors.

## Help, pop-ups and feedback

- A small **(i)** beside the main fields explains each one in a sentence. It opens with a click, Enter or Space, and closes with Escape or a click elsewhere.
- A menu bar at the top links to the **How to guide** (`howto.html`, step by step with annotated screenshots, including finding symbols with the patio door sample; retaken with `node scripts/make-howto-shots.mjs`) and the **FAQ** (`faq.html`). Both pages are English only for now; the menu and footer are translated.
- The footer carries the not-affiliated notice, the privacy line, an as-is note and the version number (set in `js/config.js`).
- **Send feedback** (in the menu bar) appears when `FEEDBACK` in `js/config.js` has a form address (`url`) or a shared email (`email`). Leave both empty and the link is hidden. Use a shared address, not a personal one.
- Slow searches show a progress bar over the drawing, and error messages have a **Copy details** button (version, browser and settings, never a file name).
- The language list shows a flag beside each language. A flag stands for a country, so the language name is always shown with it.
- `index.html` has Open Graph tags for link previews, with `docs/preview.png` as the picture. When the site has its own address, make `og:image` a full web address.

## Keyboard and screen readers

Everything can be done without a mouse: there is a *Skip to the drawing* link, the drawing window takes focus and responds to the zoom keys, pins are buttons you can reach with Tab, and a search area or symbol box can be drawn with the arrow keys (Shift for bigger steps, Alt for fine steps), Enter for each corner and Escape to cancel. Controls have names for screen readers, and messages are announced as they appear.

## Languages

The page is available in English, French, Spanish, German, Italian, Dutch, Portuguese, Danish, Swedish, Norwegian, Finnish, Polish and Czech. Pick one from the list at the top; the page remembers it, and the first time it uses your browser's language if it has it.

- An import template downloaded in one of those languages is read too (headings such as *Titel*, *Titre*, *Título*, *Tittel*). The X and Y position columns are found by their letter and the % sign.
- If a template's headings still aren't recognised, Plandot shows **Match the columns yourself**: say which column is the title, plan, X and Y, and carry on.
- Pin titles, plan names and rule names are yours and are never translated.
- The translations were written without a native speaker's review. To fix one, edit its file in `js/lang/`; the English text is the key, so nothing else needs changing. To add a language, copy a file there and add it to the list in `js/i18n.js`.

## Start over

The **Start over** button at the top clears the drawing, template, rules and pins and takes the page back to the beginning. It asks first, and never touches setup files you saved on your computer.

## It follows your template

An import template differs from project to project: adding a custom attribute adds a column, and hiding one removes a column. Plandot never assumes a column list. It reads the header row of the template you load, finds columns **by name**, and fills only the columns that exist.

- Custom attributes show up as extra fields on every rule. Hidden attributes disappear.
- Load a fresh template whenever the project's attributes change. Saved rule values for a column that no longer exists are ignored, and the page says so.
- If a column the import needs (Title, Plan, X Pos, Y Pos) is missing, the page says so instead of producing a bad file.
- Everything else in the template (formatting, widths, the header block) is left exactly as it was.
- Pre-filled IDs in the template are left out of the import file, and new pins have a blank ID, so existing items are never touched.
- The importer takes up to 500 rows per file, so bigger exports are split into numbered parts. Plandot says how many imports that needs (1,200 pins is 3 imports: 500 + 500 + 200) and labels the button *Download 3 import files*.

## Privacy

Everything runs in your browser. The drawing, the template and the rules are never uploaded anywhere, and there is no server. Your rules and language are remembered in the browser's own storage on your computer only.

Real drawings and import templates can be confidential or carry personal details, so this repository's `.gitignore` blocks `*.pdf` and `*.xlsx` apart from the two made-up files in `samples/`.

## Limits

- Callouts must be real text in the PDF, as in an export from CAD or Revit. A scan has no text to find (the page says so).
- Following leaders to dots needs the drawing's line work. A flattened PDF has none and falls back to pinning on the callout text.
- Template headings in languages other than the twelve above are matched by hand (see Languages).
- One PDF page at a time, because each page is its own plan.
- Searching other symbol sizes covers half to double the boxed copy.
- `{room}` in a pin title is the nearest room label to the pin. A dot on a wall between two rooms can pick either, and pins on outer walls may be too far from any label to get one. Check titles before importing, or leave the room out of the title.

## Run it yourself

It is a static site: no build step, no server code. From this folder:

```bash
python3 -m http.server 8080      # then open http://localhost:8080
```

Opening `index.html` by double-clicking does not work, because browsers block the page's scripts when they come from a file rather than a web address. Any static host (GitHub Pages, Netlify, Cloudflare Pages) serves it as it is.

## Tests

```bash
npm install
npx playwright install chromium
python3 -m pip install openpyxl     # the tests read the import file back with it
npm test                            # 150 tests
```

GitHub runs the same tests on every push (`.github/workflows/tests.yml`). The tests build their own drawings and templates, or use the made-up files in `samples/`.

To rebuild the samples: `python3 samples/make_sample_drawing.py` and `python3 samples/make_symbol_sample.py` (need `reportlab`) and `node scripts/make-sample-template.mjs`.

## Roadmap

- A native-speaker review of the translations
- Symbol matching for scanned drawings (image matching)
- Help pages in other languages, and a short video walkthrough
- A usage counter without cookies (disclosed in the FAQ)
- Accounts and billing, once the app has a home of its own
- Vision-assisted pins for locations with no label, such as wall ends and cable end points
- CAD (DXF) input for exact line endpoints on a named layer

## About

Plandot is an independent project by Flinn Ginder-Poulsen. It is not an official Fieldwire product; Fieldwire is a trademark of its owner and is named here only to say which import format the tool writes.

All rights reserved: see `LICENSE`. Third-party libraries in `vendor/` keep their own licences: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), [JSZip](https://github.com/Stuk/jszip) (MIT or GPL-3.0), and subsets of the Inter (SIL OFL 1.1) and TeX Gyre Heros (GUST) fonts.
