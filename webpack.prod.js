const common = require('./webpack.common.js')
const htmlexport = require('./webpack.htmlexport')
const { merge } = require('webpack-merge')
const path = require('path')
const OptimizeCSSAssetsPlugin = require('optimize-css-assets-webpack-plugin')
const { EsbuildPlugin } = require('esbuild-loader')

module.exports = [
  merge(common, {
    mode: 'production',
    output: {
      path: path.join(__dirname, 'public/build'),
      publicPath: 'build/',
      filename: '[name].[contenthash].js'
    },
    optimization: {
      minimizer: [
        new EsbuildPlugin({
          target: 'es2015',
          format: 'cjs',
          // @replit/codemirror-emacs marks the calls that register its key bindings and commands
          // as `@__PURE__`. They are only there for their side effects, so the minifier must not
          // drop them because their result is unused (which would leave the emacs keymap empty).
          ignoreAnnotations: true,
          exclude: ['MathJax/extensions/a11y/mathmaps', 'reveal.js/plugin/markdown/marked.js', 'constrain-object.min.js']
        })
      ],
      splitChunks: {
        chunks: 'all'
      }
    },
    devtool: 'source-map'
  }),
  merge(htmlexport, {
    mode: 'production',
    optimization: {
      minimizer: [
        new EsbuildPlugin({
          target: 'es2015',
          format: 'cjs'
        }),
        new OptimizeCSSAssetsPlugin({})
      ]
    }
  })]
