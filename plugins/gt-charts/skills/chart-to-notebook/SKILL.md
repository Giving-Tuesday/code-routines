---
name: chart-to-notebook
description: Rebuild a chart from an image as a gt-charts example notebook, a .py file that Databricks imports as a notebook. Use when someone shares an image or screenshot of a chart and wants it in gt-charts, in Databricks, or as a GivingTuesday embed chart.
argument-hint: <chart-image> [output.py]
---

Rebuild the chart in the image the user shared, or the image at the path in $0, with `gt.chart(...)` only, as a Databricks source notebook. If the user gave an output path in $1, write the notebook there. Otherwise write `notebooks/<chart_type>.py` in a gt-charts checkout, or `<chart_type>.py` anywhere else, with the chart type in snake_case, such as `dumbbell.py`.

## Read gt-charts first

Read these from the `release-2.x` branch of Giving-Tuesday/gt-charts. The default branch holds the 1.x docs and no examples.

- In a local checkout, run `git fetch origin release-2.x:refs/remotes/origin/release-2.x`, then `git show origin/release-2.x:<path>`. List the examples with `git ls-tree --name-only origin/release-2.x notebooks/`.
- Otherwise, run `gh api -H "Accept: application/vnd.github.raw" "repos/Giving-Tuesday/gt-charts/contents/<path>?ref=release-2.x"`. List the examples with `gh api "repos/Giving-Tuesday/gt-charts/contents/notebooks?ref=release-2.x" --jq '.[].path'`.

Read:

- `docs/using-gt-charts.md` for the API, the chart types, and "Building a chart the embed has no type for".
- `notebooks/*.py` for the notebook format. Start from the example closest to the image.

If you cannot read the repo, stop and tell the user the skill needs access to Giving-Tuesday/gt-charts.

## Steps

1. Transcribe the image into the data cell: every category, series, value, and label, plus the title and notes. Compute derived numbers, such as gaps or totals, in code. Then check them against any the image prints. Never invent a value. List each value you read with doubt for the final report.
2. Use the native series type when the embed has one. Otherwise build the shape from helper series as the docs section describes. Write every formatter as a string template.
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

   - If it says "the embed rendered nothing", add `--local-bundle`. That option downloads the bundle with `npm`.
   - If Playwright cannot find a browser and Chromium is installed, pass `--chromium <path>`. Otherwise run `playwright install chromium` in the same environment.
5. View each PNG next to the source image. Compare every value, label, color, legend entry, and axis range. Fix the notebook and render again until they match. A difference the embed causes, such as its fonts, its title layout, or its download button, stays. Report it.
6. Report the notebook path, the PNG path, the values you read with doubt, and the differences you left with the reason for each. To import the file, the user opens a Databricks workspace folder and chooses **Import**, then **File**.

If you cannot run Python or a browser here, write the notebook anyway. Tell the user it is unrendered, and list what to check when they run it.
