---
name: chart-to-notebook
description: Rebuild a chart from an image as a gt-charts example notebook, a .py file that Databricks imports as a notebook. Use when someone shares an image or screenshot of a chart and wants it in gt-charts, in Databricks, or as a GivingTuesday embed chart.
argument-hint: <chart-image> [output.py]
---

Rebuild the chart in the image the user shared, or the image at the path in $0, with `gt.chart(...)` only, as a Databricks source notebook. Match the chart's function, shapes, and data, not its look. gt-charts and the embed's theme decide colours, fonts, axis lines, ticks, grid lines, sizes, and spacing. If the user gave an output path in $1, write the notebook there. Otherwise write `notebooks/<chart_type>.py` in a gt-charts checkout, or `<chart_type>.py` anywhere else, with the chart type in snake_case, such as `dumbbell.py`.

## Read gt-charts first

Read these from the `release-2.x` branch of Giving-Tuesday/gt-charts. The default branch holds the 1.x docs and no examples.

- In a local checkout, run `git fetch origin release-2.x:refs/remotes/origin/release-2.x`, then `git show origin/release-2.x:<path>`. List the examples with `git ls-tree --name-only origin/release-2.x notebooks/`.
- Otherwise, run `gh api -H "Accept: application/vnd.github.raw" "repos/Giving-Tuesday/gt-charts/contents/<path>?ref=release-2.x"`. List the examples with `gh api "repos/Giving-Tuesday/gt-charts/contents/notebooks?ref=release-2.x" --jq '.[].path'`.

Read:

- `docs/using-gt-charts.md` for the API and the chart types.
- `notebooks/*.py` for the notebook format. Start from the example closest to the image, and copy its structure, not its styling. Skip `notebooks/image.py`, which shows PNG export, not a chart.

If you cannot read the repo, stop and tell the user the skill needs access to Giving-Tuesday/gt-charts.

## Build shapes from helper series

When the embed has no series type for the chart, combine series that each draw part of the shape. These rules hold for gt-embed 2.0.0-beta.4:

- The embed drops `markLine` and `markArea`. Draw a reference line as a two-point `line` series, and set `"symbolSize": 0` so its ends don't read as data points.
- The embed shows a legend when a chart has two or more series, not counting error bars, and lists every series that has a `name`. Leave helper series unnamed.
- The embed prints a value label inside every stacked bar. Set `"label": {"show": False}` on a helper bar, such as a transparent offset bar.
- A `custom` series draws only the shape its `renderItem` names, `"errorBar"` or `"barRange"`.

`notebooks/dumbbell.py` uses the first three.

## Steps

1. Transcribe the image into the data cell: every category, series, value, and label, plus the title and notes. Drop words that point at a colour, such as "(red)", because the theme picks the colours. Let the legend name the series instead. Compute derived numbers, such as gaps or totals, in code. Then check them against any the image prints. Never invent a value. List each value you read with doubt or inferred, such as a reference line with no printed number, for the final report.
2. Use the native series type when the embed has one. Otherwise build the shape from helper series as described above. Set only what changes what the chart shows: series types, data, categories, stacking, labels that print values, and reference lines. Leave every style option and the `theme` keyword unset. If the image uses colour to mark groups, make each group its own series, so the theme's palette colours it. Write every formatter as a string template.
3. Write the notebook in this shape. Databricks imports the file as a plain file unless the first line is exactly `# Databricks notebook source`.

   ```python
   # Databricks notebook source

   import gt_charts as gt

   # COMMAND ----------

   # the data cell

   # COMMAND ----------

   gt.chart(...).show()
   ```

   Put the image's title, subtitle, and notes in the `title`, `subtitle`, and `description` keywords, never in `option.title`. If the image has one long title, put the figure name in `title` and the rest in `subtitle`.
4. Render the notebook with `render.py` in this skill's directory, using the gt-charts version the user's Databricks runs. If the user doesn't know it, use the newest `v2` tag, a beta included, from `git ls-remote --tags https://github.com/Giving-Tuesday/gt-charts`.

   ```bash
   uv run --with "gt-charts[export] @ git+https://github.com/Giving-Tuesday/gt-charts.git@<tag>" python <skill-dir>/render.py <notebook.py> --out-dir <tmp-dir>
   ```

   In a gt-charts checkout, run `uv run python <skill-dir>/render.py <notebook.py> --out-dir <tmp-dir>` from the checkout instead.

   - If it says "the embed rendered nothing", add `--local-bundle`. That option downloads the bundle with `npm`.
   - If Playwright cannot find a browser and Chromium is installed, pass `--chromium <path>`. Otherwise run `playwright install chromium` in the same environment.
5. View each PNG next to the source image. Compare the chart type, the series, every value and label, the legend entries, and any reference lines. Colours, fonts, and spacing will differ from the image, and that is correct. `render.py` prints a `sets style` line for each chart that sets a style key. Remove each key it lists, unless the chart cannot show its data without it. A transparent offset bar, a thin `barWidth` that turns a bar into a stem, and `"symbolSize": 0` on a reference line are such keys. Render after each removal, because a key can turn out to be needed. Fix the notebook and render again until the function and data match and every remaining style key has such a reason.
6. Report the notebook path, the PNG path, the values you read with doubt, each style key you kept with its reason, and any difference in function or data you left with its reason. To import the file, the user opens a Databricks workspace folder and chooses **Import**, then **File**.

If you cannot run Python or a browser here, write the notebook anyway. Tell the user it is unrendered, and list what to check when they run it.
