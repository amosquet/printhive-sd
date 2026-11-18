# PrintHive frontend (Astro)

Static Astro site. `/` is the public queue view (Final Design S0); `/my-prints`
hosts the "MY PRINT" inspector (Final Design S5–S7) next to the live queue;
`/submit` is the print submission flow (part details + default print settings
+ per-part options → review → submit), with an interactive three.js preview
that slices the selected model in the browser. Submitting stores the print in
`localStorage` (`printhive:myPrint`), so "View my print" on the receipt lands
on S5 (queued); dashed demo buttons advance it to printing (S6) and ready for
pickup (S7).

## Preview slicing runtime

The submit page uses the vendored `@time-estimator/browser-preview` package
(`vendor/`) to run the checksum-pinned, source-built Orca WASM engine in a Web
Worker and render generated support shapes. `bun run build` first runs
`bun run preview:runtime`, which copies the bundled, checksummed engine assets
into `public/preview-engine/` (gitignored). Resolved Orca printer profiles live
in `public/preview-profiles/` (see its `NOTICE.md`/`LICENSE.txt`).

```sh
bun create astro@latest -- --template minimal
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `bun install`             | Installs dependencies                            |
| `bun dev`             | Starts local dev server at `localhost:4321`      |
| `bun build`           | Build your production site to `./dist/`          |
| `bun preview`         | Preview your build locally, before deploying     |
| `bun astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `bun astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
