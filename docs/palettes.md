# Lab color palettes

Use **Colors** in the header to try three directions: Graphite / amber, Slate / cyan and Ink / lilac. Graphite / amber is the initial default. The choice is saved in this lab's browser storage; storage failures still leave the selector usable.

Palette changes only update CSS tokens. They do not rerun an experiment, change a dataset or submit a model/cloud request. All layouts and evidence remain available.

| Role | Treatment |
| --- | --- |
| Selected experiment / focused control | Palette accent and an explicit selected state |
| Reported agreement / successful boundary | Green, with the existing text label |
| Missing or weak evidence | Warm warning color, with the existing explanation |
| Conflict / failed boundary | Coral, with the existing failure label |
| SQL or record detail | High contrast text on a quiet inset surface |

The existing gentle surface movement uses the current palette; headings retain one plain text color. Reduced-motion preferences continue to disable animation and transitions. Controls wrap in narrow headers rather than overlapping the title.

demo/palette.css provides shared semantic tokens and component treatments. demo/palette.js adds the selector, validates saved choices and handles unavailable browser storage. The three repositories carry the same small files to remain runnable without a package install or shared hosted dependency.
