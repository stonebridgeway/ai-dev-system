# Knowledge Galaxy

[← README](../README.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md) · [Guard rails](GUARDRAILS.md)

Your vault as a galaxy you fly through, in place of Obsidian's graph view.

Obsidian places a note by its links. A note nobody links to has nowhere to go,
so it lands in the outer ring, and in a vault full of generated catalogs that is
most of the vault. The galaxy places notes the way a word2vec galaxy places
words: every note and skill is a star beside its nearest neighbours **in
meaning**. Similar notes form constellations whether or not anyone linked them.
Wikilinks are still there, drawn as warmer lines, so nothing the graph view
showed is lost.

Navigation follows anvaka's [Software Galaxies](https://github.com/anvaka/pm)
(the engine behind the word2vec
[vectorspace](https://github.com/standardgalactic/vectorspace) galaxy): WASD
to fly, mouse to look, the camera kept in the address bar.

## Build it

```bash
cd ai-dev-mcp-server
npm run galaxy                                   # every note and skill
node bin/ai-dev.mjs galaxy knowledge workflows   # only these scopes
```

Outside a clone it is the same command, `ai-dev galaxy [scope...]`, run the way
your install runs `ai-dev` ([Install](INSTALL.md)). Or ask your agent to run
`render_knowledge_galaxy` (profile `memory`). Either way the result is one file
in the vault:

```
01-system/Knowledge Galaxy.html
```

Open it in any browser with WebGL. It works from disk and offline. Rebuild
whenever the vault has changed: the command brings the search index up to date
first. On the bundled seed (674 documents) the whole run takes 2.3–2.5 seconds
when it builds the index from nothing and 1.2–1.3 seconds when the index is
current, on a 2.1 GHz Xeon — the command prints both numbers, as `documents` and
`seconds`.

The tool takes `scopes` (`knowledge`, `skills`, `workflows`, `quality`,
`projects`), `neighbors` (3–24, default 8: more gives denser, rounder
clusters), `refresh_index` (default `true`: the search index is brought up to
date first; `false` draws it as it is), `obsidian_vault` (the vault name for
"Open in Obsidian" links, default: the vault folder's name) and `seed` (the same
vault and seed always give the same galaxy).

## Flying

| Key | Does |
| --- | --- |
| `W` / `S` | forward / back |
| `A` / `D` | left / right |
| `R` / `F` | up / down |
| `Q` / `E` | roll |
| `↑` `↓` `←` `→` | turn |
| `Shift` | four times faster |
| mouse drag | look around |
| wheel | forward / back |
| `Space` | steering mode: the ship turns towards the cursor, no dragging |
| click / double click | select a star / fly to it |
| `L` | links on / off |
| `T` | labels on / off |
| `C` | colour: constellations → note kind → white |
| `+` / `−` | cruising speed |
| `0` / `Home` | overview |
| `/` or `Ctrl+K` | search |
| `Esc` | clear the selection |
| `H` or `?` | the keymap on screen |

The keys are read by their physical position. With a Russian layout active,
`W` is still the key that says `Ц`, and the ship still flies.

On a touch screen: drag to look, hold one finger to fly forward, hold two to fly
back, tap to select.

## What you are looking at

- **A star** is a note, a skill, or a project file the search index holds. A
  skill that has a card note is one star, not two. The index folds the pair
  into one search result, and the galaxy folds it the same way.
- **Its size** is how many neighbours it has. A star that many notes resemble
  is big.
- **A constellation** is a community of the neighbour graph (Louvain
  modularity). Its name is the pair of title words most particular to it.
  That name is computed, not written, so a constellation of brand names may
  have none.
- **Lines**: by default only the short links are drawn, because all of them is a
  hairball. `ml` in the address sets the cut-off. Wikilinks are always drawn,
  in a warm colour. Selecting a star draws all its links and dims the rest.
- **The card** a selected star opens lists its nearest neighbours with their
  similarity, the notes it links to, a preview, and an **Open in Obsidian**
  button.

Positions are a layout, not a measurement. Two stars side by side are similar.
Two stars far apart are only *less* similar, by no particular amount.

## Where the positions come from

The galaxy uses the best vectors the search index has:

- **BGE-M3** vectors, for every document that has one. Build them with
  `npm run setup -- --model` ([Install](INSTALL.md)).
- The index's **keyword vectors** place the rest, weighted so a word every note
  carries does not pull them all together.

The status bar says which space you are in: `BGE-M3 space`, `keyword space`,
or both. A galaxy built from keyword vectors is useful. One built from BGE-M3
vectors is better: it groups notes by what they mean rather than by the words
they share.

Under that: each document is joined to its eight nearest neighbours. The
search runs in a 96-dimension principal subspace and is re-scored exactly;
on the bundled seed that finds 98% of the true eight neighbours in about half
the exact search's time. A force layout with the physics of
`ngraph.forcelayout` then settles the result. It starts from the documents'
principal coordinates, and springs between constellations are weaker than
springs inside one.

## What the file contains, and what it does not do

The page carries the titles, vault paths and a 240-character preview of every
document it draws. **Sharing the file shares those.**

It makes no request of any kind. It loads no script, font or image from
anywhere, and its Content-Security-Policy (made of the hashes of its own two
inline blocks) would refuse one if it tried. Vault text is written into the
page with `textContent`, never parsed as HTML, so no note title can turn into
markup.

## Limits

- **Time grows with the square of the vault.** Measured on a 2.1 GHz Xeon:
  the bundled seed's 674 documents in 2.3–2.5 s, index included; 10,000 and
  20,000 documents — synthetic, made from the seed's own vectors — in 33 s and
  104 s for the graph, constellations and layout alone, about three quarters of
  it the neighbour graph.
- **One galaxy draws at most 20,000 documents.** Past that, narrow it with
  scopes.
- **Past about 10,000 documents, run it from the command line.** An MCP client
  may give up on the call first: the MCP SDK's default request timeout is
  60 seconds.
- **The viewer needs WebGL.** Without it the page says so rather than showing a
  blank sky.
