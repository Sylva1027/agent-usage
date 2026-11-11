# 来源业务贡献接口

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

`business-merge.mjs` 导出 `mergeBusinessParts(parts, options)`，返回与 compat.productProjection 相同五个业务字段。

`parts` 数组项为 `{sourceId, projection, facts}`。projection 是该source所有events配同一个完整context、同一filters/now/catalog计算的 productProjection。主代理只对新来源/变化来源计算；未变化的部分按events数组身份和筛选/价目/时钟边界复用。

options：`{context, pricingCatalog, now:Date, range, bucket}`。range 是 resolveDateRange 得到的全局范围（Date start/end，preset/calendarZone），bucket是全局deriveTimelineBucket结果。仅优化普通非rolling、非quota范围；不支持路径由main保留原算法。all的来源partial起止可不同，合成必须用options.range和全局bucket；普通范围的summary范围字段为 `{preset,start:ISO|null,end:ISO|null,bucket,calendarZone,rolling:false}`。

facts 不含raw事件，形状如下，所有Map/Set为内存对象：

- `sessions: Map<sessionId, Order>` 当前范围会话首现位置；`previousSessions: Map<sessionId,Order>` 前周期；Order为 `[timestampString,sourceId,eventId]`，比较各字段localeCompare，保持旧gateway排序。
- `groups: {channels,homes,models,projects,repositories}`，每项 `Map<groupKey,{order:Order,sessions:Map<sessionId,Order>}>`，key和product summary完全相同。合并相同key会话去重，count/total由partial相加；非repo按total降序、同total按首现order，repo按total降序再name UTF16。
- `repositories:Map<repoKey,{paths:Set<string>,order:Order,kind:string}>` 当前范围repo paths去重，kind取最早order。
- `timeline:Map<bucketKey,{sessions:Map<sessionId,Order>,channels:Map<groupKey,{order,sessions}>,models:Map<groupKey,{order,sessions}>}>` 当前范围；timeline rows/分组/成本使用partial结果，sessions必须跨source去重。
- `metadataSessions:Set<sessionId>` 全source不受exclude/current range影响；`metadataHomes:Map<homeId,{count:number,sessions:Set<sessionId>}>` 同理。
- `periodRepositories:Map<repoKey,{paths:Set<string>,order:Order,kind:string}>` 全source有效时间、未排除home的事件，不受当前summary范围影响；供periodComparison repository pathCount/kind，name取partial最小值。
- `cacheRateInput:number, cacheRateCached:number` 当前范围费用accumulator缓存率分子分母（含estimate自身相应字段）；`priceModels:Set<string>` 当前范围估价返回的canonical known model，供costEstimate.modelCount。

合成要求：

- summary totals/counts精确相加，sessions、homeCount用上述身份集合（homeCount可从metadata以外的 `selectedHomes:Set<homeId>` 合并）；comparison前期totals/count相加、previousSessions去重，调用usageComparisonFromAggregates重建趋势。
- metadata generatedAt/homes/warnings直接来自context，eventCount相加，metadataSessions/Homes跨source去重，homeCount=context.homes.length，status按合成count。
- costEstimate所有计数/钱字段合并，币种null语义、modelCount、cacheHitRate、priceSource及数组集合保持现有算法。浮点只容许清楚记录的舍入差，整数精确。
- timeline按buildTimelineRows([],range,bucket)生成全局槽位，再合成partial非零行；sessions/分组去重，costByModel处理同一模型多币种键（model+NUL+currency），各pricingStatus/coverage/scenarioReasons保持算法。空槽必须原样，不能增加多余字段。
- repository sessionIds按每个session首现Order排序；paths去重，不把各source pathCount相加。
- periodComparison四时段整数metrics相加，模型/repo按key合并；periods start/end使用calendarPresetRange，all起止合并排除homes后各partial的all边界（不能使用summary包含被排除事件的范围）；全部被排除时null/null；asOf=now。repository pathCount/kind按periodRepositories；模型/仓库排序按periods.all.total降序再name。
