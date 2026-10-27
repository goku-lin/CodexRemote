# Third-party notices

The direct runtime and build dependencies declared by this project are:

| Package | Version | License |
| --- | --- | --- |
| `web-push` | 3.6.7 | MPL-2.0 |
| `werift` | 0.25.0 | MIT |
| `esbuild` | 0.25.12 | MIT |

The lockfile includes additional transitive dependencies under MIT, BSD-3-Clause, Apache-2.0, ISC, 0BSD, Unlicense and MPL-2.0 terms. Each dependency remains under its own license; this project's MIT license does not replace them.

Connector builds inspect the dependencies actually included by the bundler and distribute their license texts and version-specific npm source URLs in `app/dependency-notices.txt`. They also include the installed corresponding source of bundled MPL-2.0 packages in `app/third-party-sources/<package>-<version>.zip`, including those packages' license and copyright notices. These source archives can be extracted independently of the executable bundles.

For web-push 3.6.7, the MPL-2.0 source is included as `app/third-party-sources/web-push-3.6.7.zip` and is also available at https://registry.npmjs.org/web-push/-/web-push-3.6.7.tgz. Its upstream project is https://github.com/web-push-libs/web-push. The Node.js runtime's license and bundled dependency notices are included separately in `runtime/LICENSE.txt`.

Some npm packages declare a license but omit its full text. The exact upstream license texts for werift 0.25.0 and http_ece 1.2.0 are retained in `third_party/licenses/`, with upstream commit URLs and SHA-256 hashes in `sources.json`. Builds include those texts in the dependency notices and stop if a bundled package has no available license text.
