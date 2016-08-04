import fs from 'fs'
import path from 'path'

import glob from 'glob'
import ora from 'ora'
import temp from 'temp'
import merge from 'webpack-merge'

import cleanModule from './commands/clean-module'
import createBabelConfig from './createBabelConfig'
import {UserError} from './errors'
import exec from './exec'
import getUserConfig from './getUserConfig'
import {createBanner, createWebpackExternals} from './utils'
import webpackBuild from './webpackBuild'
import {logGzippedFileSizes} from './webpackUtils'

/**
 * Runs Babel with generated config written to a temporary .babelrc.
 */
function runBabel(src, outDir, buildBabelConfig, userBabelConfig) {
  let babelConfig = createBabelConfig(buildBabelConfig, userBabelConfig)
  fs.writeFileSync('.babelrc', JSON.stringify(babelConfig, null, 2))
  try {
    exec('babel', [src, '--out-dir', outDir, '--quiet'])
  }
  finally {
    fs.unlinkSync('.babelrc')
  }
}

export default function moduleBuild(args, buildConfig = {}, cb) {
  // XXX Babel doesn't support passing the path to a babelrc file any more
  if (glob.sync('.babelrc').length > 0) {
    throw new UserError(
      'Unable to build the module as there is a .babelrc in your project',
      'nwb needs to write a temporary .babelrc to configure the build',
    )
  }

  cleanModule(args)

  let src = path.resolve('src')
  let userConfig = getUserConfig(args)

  let spinner = ora('Creating ES5 build').start()
  runBabel(
    src,
    path.resolve('lib'),
    merge(buildConfig.babel, buildConfig.babelDev || {}, {
      // Don't force ES5 users of the ES5 build to eat a .require
      plugins: [require.resolve('babel-plugin-add-module-exports')],
    }),
    userConfig.babel,
  )
  spinner.succeed()

  if (userConfig.npm.nativeModules) {
    spinner = ora('Creating ES6 modules build').start()
    runBabel(
      src,
      path.resolve('es6'),
      merge(buildConfig.babel, buildConfig.babelDev || {}, {
        // Don't transpile modules, for ES6 module bundlers
        nativeModules: true,
      }),
      userConfig.babel,
    )
    spinner.succeed()
  }

  temp.cleanupSync()

  if (!userConfig.npm.umd) {
    return cb()
  }

  spinner = ora('Creating UMD builds').start()

  let pkg = require(path.resolve('package.json'))
  let entry = path.resolve(args._[1] || 'src/index.js')
  let webpackBuildConfig = {
    babel: buildConfig.babel,
    entry: [entry],
    output: {
      filename: `${pkg.name}.js`,
      library: userConfig.npm.umd.global,
      libraryTarget: 'umd',
      path: path.resolve('umd'),
    },
    externals: createWebpackExternals(userConfig.npm.umd.externals),
    polyfill: false,
    plugins: {
      banner: createBanner(pkg),
    },
  }

  process.env.NODE_ENV = 'development'
  webpackBuild(args, webpackBuildConfig, (err, stats1) => {
    if (err) {
      spinner.fail()
      return cb(err)
    }
    process.env.NODE_ENV = 'production'
    webpackBuildConfig.babel = merge(buildConfig.babel, buildConfig.babelProd || {})
    webpackBuildConfig.devtool = 'source-map'
    webpackBuildConfig.output.filename = `${pkg.name}.min.js`
    webpackBuild(args, webpackBuildConfig, (err, stats2) => {
      if (err) {
        spinner.fail()
        return cb(err)
      }
      spinner.succeed()
      console.log()
      logGzippedFileSizes(stats1, stats2)
      cb()
    })
  })
}