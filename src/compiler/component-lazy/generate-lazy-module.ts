import * as d from '../../declarations';
import { writeLazyModule } from './write-lazy-entry-module';
import { DEFAULT_STYLE_MODE, sortBy } from '@utils';
import { optimizeModule } from '../app-core/optimize-module';
import { transpileToEs5Main } from '../transpile/transpile-to-es5-main';
import { formatComponentRuntimeMeta, stringifyRuntimeData } from '../app-core/format-component-runtime-meta';


export async function generateLazyModules(config: d.Config, compilerCtx: d.CompilerCtx, buildCtx: d.BuildCtx, destinations: string[], rollupResults: d.RollupResult[], sourceTarget: d.SourceTarget, sufix: string) {
  const entryComponetsResults = rollupResults.filter(rollupResult => rollupResult.isComponent);
  const chunkResults = rollupResults.filter(rollupResult => !rollupResult.isComponent && !rollupResult.isAppCore);

  const [bundleModules] = await Promise.all([
    Promise.all(entryComponetsResults.map(rollupResult => {
      return generateLazyEntryModule(config, compilerCtx, buildCtx, destinations, rollupResult, sourceTarget, sufix);
    })),
    Promise.all(chunkResults.map(rollupResult => {
      return writeLazyChunk(config, compilerCtx, buildCtx, destinations, sourceTarget, rollupResult.code, rollupResult.fileName);
    }))
  ]);

  const coreResults = rollupResults.filter(rollupResult => rollupResult.isAppCore);
  await Promise.all(
    coreResults.map(rollupResult => {
      return writeLazyCore(config, compilerCtx, buildCtx, destinations, sourceTarget, rollupResult.code, rollupResult.fileName, bundleModules);
    })
  );
}


async function generateLazyEntryModule(config: d.Config, compilerCtx: d.CompilerCtx, buildCtx: d.BuildCtx, destinations: string[], rollupResult: d.RollupResult, sourceTarget: d.SourceTarget, sufix: string): Promise<d.BundleModule> {
  const entryModule = buildCtx.entryModules.find(entryModule => entryModule.entryKey === rollupResult.entryKey);
  let code = rollupResult.code;

  if (sourceTarget === 'es5') {
    const result = await transpileToEs5Main(config, compilerCtx, code, true);
    buildCtx.diagnostics.push(...result.diagnostics);
    if (result.diagnostics.length === 0) {
      code = result.code;
    }
  }

  if (config.minifyJs) {
    const optimizeResults = await optimizeModule(config, compilerCtx, 'es2017', code);
    buildCtx.diagnostics.push(...optimizeResults.diagnostics);

    if (optimizeResults.diagnostics.length === 0 && typeof optimizeResults.output === 'string') {
      code = optimizeResults.output;
    }
  }
  const outputs = await Promise.all(
    entryModule.modeNames.map(modeName =>
      writeLazyModule(config, compilerCtx, destinations, entryModule, code, modeName, sufix)
    )
  );

  return {
    entryKey: rollupResult.entryKey,
    modeNames: entryModule.modeNames.slice(),
    cmps: entryModule.cmps,
    outputs: sortBy(outputs, o => o.modeName)
  };
}

export async function writeLazyChunk(config: d.Config, compilerCtx: d.CompilerCtx, buildCtx: d.BuildCtx, destinations: string[], sourceTarget: d.SourceTarget, code: string, filename: string) {
  if (sourceTarget === 'es5') {
    const transpileResults = await transpileToEs5Main(config, compilerCtx, code, true);
    buildCtx.diagnostics.push(...transpileResults.diagnostics);
    if (transpileResults.diagnostics.length === 0) {
      code = transpileResults.code;
    }
  }

  if (config.minifyJs) {
    const optimizeResults = await optimizeModule(config, compilerCtx, sourceTarget, code);
    buildCtx.diagnostics.push(...optimizeResults.diagnostics);

    if (optimizeResults.diagnostics.length === 0 && typeof optimizeResults.output === 'string') {
      code = optimizeResults.output;
    }
  }

  return Promise.all(destinations.map(dst => {
    const filePath = config.sys.path.join(dst, filename);
    return compilerCtx.fs.writeFile(filePath, code);
  }));
}

export async function writeLazyCore(config: d.Config, compilerCtx: d.CompilerCtx, buildCtx: d.BuildCtx, destinations: string[], sourceTarget: d.SourceTarget, code: string, filename: string, bundleModules: d.BundleModule[]) {
  const lazyRuntimeData = formatLazyBundlesRuntimeMeta(bundleModules);
  code = code.replace(
    `[/*!__STENCIL_LAZY_DATA__*/]`,
    `${lazyRuntimeData}`
  );

  return writeLazyChunk(config, compilerCtx, buildCtx, destinations, sourceTarget, code, filename);
}

function formatLazyBundlesRuntimeMeta(bundleModules: d.BundleModule[]) {
  // [[{ios: 'abc12345', md: 'dec65432'}, {cmpTag: 'ion-icon', cmpMembers: []}]]

  const lazyBundles = bundleModules.map(formatLazyRuntimeBundle);
  return stringifyRuntimeData(lazyBundles);
}


function formatLazyRuntimeBundle(bundleModule: d.BundleModule): d.LazyBundleRuntimeData {
  let bundleId: any;
  if (bundleModule.outputs.length === 0) {
    throw new Error('bundleModule.output must be at least one');
  }

  if (bundleModule.outputs[0].modeName !== DEFAULT_STYLE_MODE) {
    // more than one mode, object of bundleIds with the mode as a key
    bundleId = {};
    bundleModule.outputs.forEach(output => {
      bundleId[output.modeName] = output.bundleId;
    });

  } else {
    // only one default mode, bundleId is a string
    bundleId = bundleModule.outputs[0].bundleId;
  }

  return [
    bundleId,
    bundleModule.cmps.map(cmp => formatComponentRuntimeMeta(cmp, true, true))
  ];
}