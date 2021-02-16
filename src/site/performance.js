/* global sauce, jQuery, Chart, Backbone */

sauce.ns('performance', async ns => {
    'use strict';

    const DAY = 86400 * 1000;
    const TZ = (new Date()).getTimezoneOffset() * 60000;

    const urn = 'sauce/performance';
    const chartTopPad = 30;  // Helps prevent tooltip clipping.

    await sauce.propDefined('Backbone.Router', {once: true});
    const AppRouter = Backbone.Router.extend({
        constructor: function() {
            this.filters = {};
            Backbone.Router.prototype.constructor.apply(this, arguments);
        },

        routes: {
            [`${urn}/:athleteId/:period/:startDay/:endDay`]: 'onNav',
            [`${urn}/:athleteId/:period`]: 'onNav',
            [`${urn}/:athleteId`]: 'onNav',
            [urn]: 'onNav',
        },

        onNav: function(athleteId, period, startDay, endDay) {
            this.filters = {
                athleteId: athleteId && Number(athleteId),
                period: period && Number(period),
                periodStart: startDay && startDay * DAY + TZ,
                periodEnd: endDay && endDay * DAY + TZ,
            };
        },

        setAthlete: function(athleteId, options) {
            this.filters.athleteId = athleteId;
            this.filterNavigate(options);
        },

        setPeriod: function(athleteId, period, start, end) {
            this.filters.athleteId = athleteId;
            this.filters.period = period;
            this.filters.periodStart = start;
            this.filters.periodEnd = end;
            this.filterNavigate();
        },

        filterNavigate: function(options={}) {
            const f = this.filters;
            if (f.periodEnd != null && f.periodStart != null && f.period != null &&
                f.athleteId != null) {
                const startDay = (f.periodStart - TZ) / DAY;
                const endDay = (f.periodEnd - TZ) / DAY;
                this.navigate(`${urn}/${f.athleteId}/${f.period}/${startDay}/${endDay}`, options);
            } else if (f.period != null && f.athleteId != null) {
                this.navigate(`${urn}/${f.athleteId}/${f.period}`, options);
            } else if (f.athleteId != null) {
                this.navigate(`${urn}/${f.athleteId}`, options);
            } else {
                this.navigate(`${urn}`, options);
            }
        }
    });
    ns.router = new AppRouter();
    Backbone.history.start({pushState: true});

    await sauce.proxy.connected;
    // XXX find something just after all the locale stuff.
    await sauce.propDefined('Strava.I18n.DoubledStepCadenceFormatter', {once: true});
    await sauce.locale.init();
    await sauce.propDefined('Backbone.View', {once: true});
    const view = await sauce.getModule('/src/site/view.mjs');

    const currentUser = await sauce.storage.get('currentUser');


    const _syncControllers = new Map();
    function getSyncController(athleteId) {
        if (!_syncControllers.has(athleteId)) {
            _syncControllers.set(athleteId, new sauce.hist.SyncController(athleteId));
        }
        return _syncControllers.get(athleteId);
    }


    async function getCurrentPeriod() {
        return ns.router.filters.period ||
            await sauce.storage.getPref('perfMainViewDefaultPeriod') ||
            182;
    }


    // XXX maybe Chart.helpers has something like this..
    function setDefault(obj, path, value) {
        path = path.split('.');
        let offt = obj;
        let m;
        const arrayPushMatch = /(.*?)\[\]/;
        const arrayIndexMatch = /(.*?)\[([0-9]+)\]/;
        for (const x of path.slice(0, -1)) {
            if ((m = x.match(arrayPushMatch))) {
                offt = offt[m[1]] || (offt[m[1]] = []);
                offt = offt.push({});
            } else if ((m = x.match(arrayIndexMatch))) {
                offt = offt[m[1]] || (offt[m[1]] = []);
                const i = Number(m[2]);
                offt = offt[i] || (offt[i] = {});
            } else {
                offt = offt[x] || (offt[x] = {});
            }
        }
        const edge = path[path.length - 1];
        if (offt[edge] !== undefined) {
            return;
        }
        if ((m = edge.match(arrayPushMatch))) {
            offt = offt[m[1]] || (offt[m[1]] = []);
            offt.push(value);
        } else if ((m = edge.match(arrayIndexMatch))) {
            offt = offt[m[1]] || (offt[m[1]] = []);
            offt[Number(m[2])] = value;
        } else {
            offt[edge] = value;
        }
    }


    function getPeaksUnit(type) {
        const paceUnit = sauce.locale.paceFormatter.shortUnitKey();
        return {
            power_wkg: 'w/kg',
            power: 'w',
            np: 'w',
            xp: 'w',
            hr: 'bpm', // XXX
            pace: paceUnit,
            gap: paceUnit,
        }[type];
    }


    function getPeaksValueFormatter(type) {
        return {
            power: sauce.locale.human.number,
            power_wkg: x => sauce.locale.human.number(x, 1),
            np: sauce.locale.human.number,
            xp: sauce.locale.human.number,
            hr: sauce.locale.human.number,
            pace: sauce.locale.human.pace,
            gap: sauce.locale.human.pace,
        }[type];
    }


    function getPeaksSortDirection(type) {
        if (['pace', 'gap'].includes(type)) {
            return 'next';
        } else {
            return 'prev';
        }
    }


    async function editActivityDialogXXX(activity, pageView) {
        // XXX replace this trash with a view and module
        const tss = sauce.model.getActivityTSS(activity);
        const $modal = await sauce.modal({
            title: 'Edit Activity', // XXX localize
            icon: await sauce.images.asText('fa/edit-duotone.svg'),
            body: `
                <b>${activity.name}</b><hr/>
                <label>TSS Override:
                    <input name="tss_override" type="number"
                           value="${activity.tssOverride != null ? activity.tssOverride : ''}"
                           placeholder="${tss != null ? Math.round(tss) : ''}"/>
                </label>
                <hr/>
                <label>Exclude this activity from peak performances:
                    <input name="peaks_exclude" type="checkbox"
                           ${activity.peaksExclude ? 'checked' : ''}/>
                </label>
            `,
            extraButtons: [{
                text: 'Save', // XXX localize
                click: async ev => {
                    const updates = {
                        tssOverride: Number($modal.find('input[name="tss_override"]').val()) || null,
                        peaksExclude: $modal.find('input[name="peaks_exclude"]').is(':checked'),
                    };
                    ev.currentTarget.disabled = true;
                    ev.currentTarget.classList.add('sauce-loading');
                    try {
                        await sauce.hist.updateActivity(activity.id, updates);
                        Object.assign(activity, updates);
                        await sauce.hist.invalidateActivitySyncState(activity.id, 'local', 'training-load',
                            {disableSync: true});
                        await sauce.hist.invalidateActivitySyncState(activity.id, 'local', 'peaks', {wait: true});
                        await pageView.render();
                    } finally {
                        ev.currentTarget.classList.remove('sauce-loading');
                        ev.currentTarget.disabled = false;
                    }
                    $modal.dialog('destroy');
                }
            }, {
                text: 'Reimport', // XXX localize
                click: async ev => {
                    ev.currentTarget.disabled = true;
                    ev.currentTarget.classList.add('sauce-loading');
                    try {
                        await sauce.hist.invalidateActivitySyncState(activity.id, 'streams');
                        await pageView.render();
                    } finally {
                        ev.currentTarget.classList.remove('sauce-loading');
                        ev.currentTarget.disabled = false;
                    }
                }
            }]
        });
        return $modal;
    }


    function activitiesByDay(acts, start, end, atl=0, ctl=0) {
        // NOTE: Activities should be in chronological order
        if (!acts.length) {
            return [];
        }
        const slots = [];
        const startDay = sauce.date.toLocaleDayDate(start);
        let i = 0;
        for (const date of sauce.date.dayRange(startDay, new Date(end))) {
            if (!acts.length) {
                break;
            }
            let tss = 0;
            let duration = 0;
            let altGain = 0;
            const ts = date.getTime();
            const daily = [];
            while (i < acts.length && sauce.date.toLocaleDayDate(acts[i].ts).getTime() === ts) {
                const a = acts[i++];
                daily.push(a);
                tss += sauce.model.getActivityTSS(a) || 0;
                duration += a.stats && sauce.model.getActivityActiveTime(a) || 0;
                altGain += a.stats && a.stats.altitudeGain || 0;
            }
            atl = sauce.perf.calcATL([tss], atl);
            ctl = sauce.perf.calcCTL([tss], ctl);
            slots.push({
                date,
                activities: daily,
                tss,
                duration,
                atl,
                ctl,
                altGain,
            });
        }
        if (i !== acts.length) {
            throw new Error('Internal Error');
        }
        return slots;
    }


    function aggregateActivitiesByFn(daily, indexFn, aggregateFn) {
        const metricData = [];
        function agg(entry) {
            entry.tss = entry.tssSum / entry.days;
            if (aggregateFn) {
                aggregateFn(entry);
            }
        }
        for (let i = 0; i < daily.length; i++) {
            const slot = daily[i];
            const index = indexFn(slot, i);
            if (!metricData[index]) {
                if (index) {
                    agg(metricData[index - 1]);
                }
                metricData[index] = {
                    date: slot.date,
                    tssSum: slot.tss,
                    duration: slot.duration,
                    altGain: slot.altGain,
                    days: 1,
                    activities: [...slot.activities],
                };
            } else {
                const entry = metricData[index];
                entry.tssSum += slot.tss;
                entry.duration += slot.duration;
                entry.altGain += slot.altGain;
                entry.days++;
                entry.activities.push(...slot.activities);
            }
        }
        if (metricData.length) {
            agg(metricData[metricData.length - 1]);
        }
        return metricData;
    }


    function aggregateActivitiesByWeek(daily, options={}) {
        let week = null;
        return aggregateActivitiesByFn(daily, (x, i) => {
            if (options.isoWeekStart) {
                if (week === null) {
                    week = 0;
                } else if (x.date.getDay() === /*monday*/ 1) {
                    week++;
                }
                return week;
            } else {
                return Math.floor(i / 7);
            }
        });
    }


    function aggregateActivitiesByMonth(daily, options={}) {
        let month = null;
        let curMonth;
        return aggregateActivitiesByFn(daily, x => {
            const m = x.date.getMonth();
            if (month === null) {
                month = 0;
            } else if (m !== curMonth) {
                month++;
            }
            curMonth = m;
            return month;
        });
    }


    async function getSeedTrainingLoad(activity) {
        let oldestActivityID = activity.id;
        let atl = 0;
        let ctl = 0;
        while (true) {
            const seed = (await sauce.hist.getActivitySiblings(oldestActivityID,
                {direction: 'prev', limit: 1}))[0];
            if (!seed) {
                break;
            }
            if (!seed.training) {
                // Keep scanning backwards until we find an activity with legit training data.
                // This could be a workout without streams, or otherwise has errors.
                oldestActivityID = seed.id;
                continue;
            }
            atl = seed.training.atl || 0;
            ctl = seed.training.ctl || 0;
            // Drain inactive days between the seed and the activity...
            const seedDay = sauce.date.toLocaleDayDate(seed.ts);
            const firstDay = sauce.date.toLocaleDayDate(activity.ts);
            const zeros = [...sauce.date.dayRange(seedDay, firstDay)].map(() => 0);
            zeros.pop();  // Exclude seed day.
            if (zeros.length) {
                atl = sauce.perf.calcATL(zeros, atl);
                ctl = sauce.perf.calcCTL(zeros, ctl);
            }
            break;
        }
        return {atl, ctl};
    }


    class ChartVisibilityPlugin {
        constructor(config, view) {
            const _this = this;
            setDefault(config, 'options.legend.onClick', function(...args) {
                _this.onLegendClick(this, ...args);
            });
            this.view = view;
        }

        onLegendClick(element, ev, item) {
            this.legendClicking = true;
            try {
                Chart.defaults.global.legend.onClick.call(element, ev, item);
            } finally {
                this.legendClicking = false;
            }
            const index = item.datasetIndex;
            const id = element.chart.data.datasets[index].id;
            if (!id) {
                console.warn("No ID for dataset");
                return;
            }
            jQuery(element.chart.canvas).trigger('dataVisibilityChange', {
                id,
                visible: element.chart.isDatasetVisible(index)
            });
        }

        beforeUpdate(chart) {
            // Skip setting the hidden state when the update is from the legend click.
            if (this.legendClicking) {
                return;
            }
            const chartId = chart.canvas.id;
            if (!chartId) {
                console.error("Missing canvas ID needed for visibility mgmt.");
                return;
            }
            for (const ds of chart.data.datasets) {
                if (!ds.id) {
                    console.warn("Missing ID on dataset: visiblity state unmanaged");
                    continue;
                }
                ds.hidden = this.view.dataVisibility[`${chartId}-${ds.id}`] === false;
            }
        }
    }


    const betterTooltipPlugin = {
        beforeEvent: function(chart, event) {
            if (event.type !== 'mousemove' || chart.options.tooltips.intersect !== false) {
                return;
            }
            const box = chart.chartArea;
            if (event.x < box.left ||
                event.x > box.right ||
                event.y < box.top ||
                event.y > box.bottom) {
                return false;
            }
        }
    };


    Chart.Tooltip.positioners.sides = function (elements, pos) {
        const box = this._chart.chartArea;
        const intersect = this._chart.options.tooltips.intersect;
        const xAlign = pos.x - box.left > (box.right - box.left) / 2 ? 'right' : 'left';
        this._options.xAlign = xAlign;
        this._options.yAlign = intersect === false ? 'center' : undefined;
        const yPos = intersect === false ? ((box.bottom - box.top) / 3) + chartTopPad : pos.y;
        return {
            x: pos.x,
            y: yPos
        };
    };


    const chartOverUnderFillPlugin = {
        _fillGradientSize: 100,

        _buildFillGradient: function(chart, startColor, endColor) {
            const size = this._fillGradientSize;
            const refCanvas = document.createElement('canvas');
            refCanvas.width = size;
            refCanvas.height = 2;
            const refContext = refCanvas.getContext('2d');
            const refGradient = refContext.createLinearGradient(0, 0, size, 0);
            refGradient.addColorStop(0, startColor);
            refGradient.addColorStop(1, endColor);
            refContext.fillStyle = refGradient;
            refContext.fillRect(0, 0, size, 2);
            return refContext;
        },

        _getFillGradientColor: function(ref, pct) {
            const size = this._fillGradientSize;
            pct = Math.max(0, Math.min(1, pct));
            const aPct = (Math.abs(ref.alphaMax - ref.alphaMin) * pct);
            const a = ref.alphaMax > ref.alphaMin ? aPct + ref.alphaMin : ref.alphaMin - aPct;
            const refOffset = Math.max(0, Math.min(size - 1, Math.round(pct * size)));
            const [r, g, b] = ref.gradient.getImageData(refOffset, 0, refOffset + 1, 1).data.slice(0, 3);
            return [r, g, b, a];
        },

        safePct: function(pct) {
            // Return a value that won't blow up Canvas' addColorStop().
            return Math.min(1, Math.max(0, pct));
        },

        beforeRender: function (chart, options) {
            //var model = chart.data.datasets[3]._meta[Object.keys(dataset._meta)[0]].dataset._model;
            for (const ds of chart.data.datasets) {
                if (!ds.overUnder) {
                    continue;
                }
                for (const meta of Object.values(ds._meta)) {
                    if (!meta.dataset) {
                        continue;
                    }
                    const scale = chart.scales[ds.yAxisID];
                    if (scale.height <= 0) {
                        return;  // Ignore renders to nonvisible layouts (prob a transition)
                    }
                    if (!ds._overUnderRef) {
                        // We have to preserve the alpha components externally.
                        const color = c => Chart.helpers.color(c);
                        const overMax = color(ds.overBackgroundColorMax);
                        const overMin = color(ds.overBackgroundColorMin);
                        const underMin = color(ds.underBackgroundColorMin);
                        const underMax = color(ds.underBackgroundColorMax);
                        ds._overUnderRef = {
                            over: {
                                gradient: this._buildFillGradient(chart,
                                    overMin.rgbString(), overMax.rgbString()),
                                alphaMin: overMin.alpha(),
                                alphaMax: overMax.alpha(),
                            },
                            under: {
                                gradient: this._buildFillGradient(chart,
                                    underMin.rgbString(), underMax.rgbString()),
                                alphaMin: underMin.alpha(),
                                alphaMax: underMax.alpha(),
                            }
                        };
                    }
                    const ref = ds._overUnderRef;
                    const model = meta.dataset._model;
                    const zeroPct = this.safePct(scale.getPixelForValue(0) / scale.height);
                    const gFill = chart.ctx.createLinearGradient(0, 0, 0, scale.height);
                    const max = ds.overBackgroundMax != null ? ds.overBackgroundMax : scale.max;
                    const min = ds.underBackgroundMin != null ? ds.underBackgroundMin : scale.min;
                    const midPointMarginPct = 0.001;
                    try {
                        if (scale.max > 0) {
                            const overMaxColor = this._getFillGradientColor(ref.over, scale.max / max);
                            const overMinColor = this._getFillGradientColor(ref.over, scale.min / max);
                            const topPct = this.safePct(scale.getPixelForValue(max) / scale.height);
                            gFill.addColorStop(topPct, `rgba(${overMaxColor.join()}`);
                            gFill.addColorStop(this.safePct(zeroPct - midPointMarginPct),
                                `rgba(${overMinColor.join()}`);
                            gFill.addColorStop(zeroPct, `rgba(${overMinColor.slice(0, 3).join()}, 0)`);
                        }
                        if (scale.min < 0) {
                            const underMinColor = this._getFillGradientColor(ref.under, scale.max / min);
                            const underMaxColor = this._getFillGradientColor(ref.under, scale.min / min);
                            const bottomPct = this.safePct(scale.getPixelForValue(min) / scale.height);
                            gFill.addColorStop(zeroPct, `rgba(${underMinColor.slice(0, 3).join()}, 0`);
                            gFill.addColorStop(this.safePct(zeroPct + midPointMarginPct),
                                `rgba(${underMinColor.join()}`);
                            gFill.addColorStop(bottomPct, `rgba(${underMaxColor.join()}`);
                        }
                        model.backgroundColor = gFill;
                    } catch(e) { console.error(e); }
                }
            }
        }
    };


    const drawSave = Chart.controllers.line.prototype.draw;
    Chart.controllers.line.prototype.draw = function(ease) {
        drawSave.apply(this, arguments);
        if (!this.chart.options.tooltipLine) {
            return;
        }
        const active = this.chart.tooltip._active;
        if (active && active.length) {
            const activePoint = active[0];
            const ctx = this.chart.ctx;
            const x = activePoint.tooltipPosition().x;
            const top = this.chart.chartArea.top;
            const bottom = this.chart.chartArea.bottom;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
            ctx.lineWidth = 1;
            ctx.strokeStyle = this.chart.options.tooltipLineColor || '#777';
            ctx.stroke();
            ctx.restore();
        }
    };


    class ActivityTimeRangeChart extends Chart {
        constructor(canvasSelector, view, config) {
            const ctx = document.querySelector(canvasSelector).getContext('2d');
            config = config || {};
            setDefault(config, 'type', 'line');
            setDefault(config, 'plugins[]', new ChartVisibilityPlugin(config, view));
            setDefault(config, 'plugins[]', betterTooltipPlugin);
            setDefault(config, 'options.maintainAspectRatio', false);
            setDefault(config, 'options.layout.padding.top', chartTopPad);
            setDefault(config, 'options.tooltipLine', true);
            setDefault(config, 'options.tooltipLineColor', '#07c');
            setDefault(config, 'options.animation.duration', 200);
            setDefault(config, 'options.legend.position', 'bottom');

            setDefault(config, 'options.scales.xAxes[0].id', 'days');
            setDefault(config, 'options.scales.xAxes[0].offset', true);
            setDefault(config, 'options.scales.xAxes[0].type', 'time');
            setDefault(config, 'options.scales.xAxes[0].time.tooltipFormat', 'll'); // XXX use func
            setDefault(config, 'options.scales.xAxes[0].distribution', 'series');
            setDefault(config, 'options.scales.xAxes[0].gridLines.display', true);
            setDefault(config, 'options.scales.xAxes[0].gridLines.drawOnChartArea', false);
            setDefault(config, 'options.scales.xAxes[0].afterBuildTicks', (axis, ticks) => {
                if (!ticks) {
                    return;
                }
                const days = (axis.max - axis.min) / DAY;
                const dates = ticks.map(x => new Date(x.value));
                const years = new Set(dates.map(x => x.getFullYear()));
                if (days < 32) {
                    let markedYear;
                    return dates.map((d, i) => {
                        const value = ticks[i].value;
                        if (years.size > 1 && !markedYear && d.getMonth() === 0) {
                            markedYear = true;
                            return {value, major: true, showYear: true};
                        } else if (d.getDay() === 1) {
                            return {value, major: true};
                        } else {
                            return {value, major: false};
                        }
                    });
                } else {
                    return dates.map((d, i) => {
                        const value = ticks[i].value;
                        const year = d.getFullYear();
                        if (years.has(year)) {
                            years.delete(year);
                            return {value, major: true, showYear: true};
                        } else {
                            return {value, major: ticks[i].major};
                        }
                    });
                }
            });
            setDefault(config, 'options.scales.xAxes[0].ticks.padding', 10);
            setDefault(config, 'options.scales.xAxes[0].ticks.minRotation', 10);
            setDefault(config, 'options.scales.xAxes[0].ticks.maxRotation', 40);
            setDefault(config, 'options.scales.xAxes[0].ticks.maxTicksLimit', 16);
            setDefault(config, 'options.scales.xAxes[0].ticks.callback', (_, index, ticks) => {
                const days = (ticks[ticks.length - 1].value - ticks[0].value) / DAY;
                const data = ticks[index];
                const d = new Date(data.value);
                if (days < 32) {
                    return sauce.locale.human.date(d, {style: 'shortDay'});
                } else {
                    return sauce.locale.human.date(d, {style: 'shortDay'});
                }
            });
            setDefault(config, 'options.scales.xAxes[0].ticks.major.enabled', true);
            setDefault(config, 'options.scales.xAxes[0].ticks.major.fontStyle', 'bold');
            setDefault(config, 'options.scales.xAxes[0].ticks.major.callback', (_, index, ticks) => {
                const days = (ticks[ticks.length - 1].value - ticks[0].value) / DAY;
                const data = ticks[index];
                const d = new Date(data.value);
                if (days < 32) {
                    if (data.showYear) {
                        return sauce.locale.human.date(d, {style: 'monthYear'});
                    } else {
                        return sauce.locale.human.date(d, {style: 'weekday'});
                    }
                } else {
                    if (d.getMonth() === 0 || days > 800) {
                        return sauce.locale.human.date(d, {style: 'monthYear'});
                    } else {
                        return sauce.locale.human.date(d, {style: 'month'});
                    }
                }
            });

            setDefault(config, 'options.scales.yAxes[0].type', 'linear');
            setDefault(config, 'options.scales.yAxes[0].scaleLabel.display', true);
            setDefault(config, 'options.scales.yAxes[0].ticks.min', 0);

            setDefault(config, 'options.tooltips.position', 'sides');
            setDefault(config, 'options.tooltips.mode', 'index');
            setDefault(config, 'options.tooltips.callbacks.title', (item, data) => {
                const d = new Date(data.datasets[0].data[item[0].index].x);
                return sauce.locale.human.date(d, {style: 'weekdayYear'});
            });
            setDefault(config, 'options.tooltips.callbacks.label', (item, data) => {
                const ds = data.datasets[item.datasetIndex];
                const label = ds.label || '';
                const val = ds.tooltipFormat ? ds.tooltipFormat(item.value, ds, this) : item.value;
                return `${label}: ${val}`;
            });
            setDefault(config, 'options.tooltips.callbacks.footer',
                items => this.onTooltipSummary(items));
            setDefault(config, 'options.plugins.datalabels.display', ctx =>
                ctx.dataset.data[ctx.dataIndex].showDataLabel === true);
            setDefault(config, 'options.plugins.datalabels.formatter', (value, ctx) =>
                ctx.dataset.tooltipFormat(value.y));
            setDefault(config, 'options.plugins.datalabels.backgroundColor',
                ctx => ctx.dataset.backgroundColor);
            setDefault(config, 'options.plugins.datalabels.borderRadius', 4);
            setDefault(config, 'options.plugins.datalabels.color', 'white');
            setDefault(config, 'options.plugins.datalabels.padding', 5);
            setDefault(config, 'options.plugins.datalabels.align', 'end');
            setDefault(config, 'options.plugins.datalabels.anchor', 'center');
            super(ctx, config);
            this.view = view;
        }

        onTooltipSummary(items) {
            const idx = items[0].index;
            const slot = this.options.useMetricData ? this.view.metricData[idx] : this.view.daily[idx];
            if (!slot.activities.length) {
                return '';
            }
            if (slot.activities.length === 1) {
                return `\n1 activity - click for details`; // XXX Localize
            } else {
                return `\n${slot.activities.length} activities - click for details`; // XXX Localize
            }
        }
    }


    class SummaryView extends view.SauceView {
        get events() {
            return {
                'click a.collapser': 'onCollapserClick',
                'click a.expander': 'onExpanderClick',
                'click section.overview a.missing-tss': 'onMissingTSSClick',
                'click section.results a[data-id]': 'onResultClick',
                'dblclick section > header': 'onDblClickHeader',
                'change select[name="type"]': 'onTypeChange',
            };
        }

        get tpl() {
            return 'performance-summary.html';
        }

        async init({pageView}) {
            this.pageView = pageView;
            this.period = await getCurrentPeriod();
            this.sync = {};
            this.daily = [];
            this.weekly = [];
            this.missingTSS = [];
            this.onSyncActive = this._onSyncActive.bind(this);
            this.onSyncStatus = this._onSyncStatus.bind(this);
            this.onSyncError = this._onSyncError.bind(this);
            this.onSyncProgress = this._onSyncProgress.bind(this);
            this.listenTo(pageView, 'change-athlete', this.onChangeAthlete);
            this.listenTo(pageView, 'update-period', this.onUpdatePeriod);
            this.collapsed = (await sauce.storage.getPref('perfSummarySectionCollapsed')) || {};
            this.type = (await sauce.storage.getPref('perfSummarySectionType')) || 'power';
            ns.router.on('route:onNav', this.onRouterNav.bind(this));
            await super.init();
        }

        async renderAttrs() {
            const peaks = [];
            const direction = getPeaksSortDirection(this.type);
            let periods;
            let keyFormatter;
            const mile = 1609.344;
            if (['gap', 'pace'].includes(this.type)) {
                periods = [400, 1000, mile, 10000, mile * 13.1, mile * 26.2];
                keyFormatter = sauce.locale.human.raceDistance;
            } else {
                periods = [5, 60, 300, 1200, 3600];
                keyFormatter = sauce.locale.human.duration;
            }
            const start = this.periodStart;
            const end = this.periodEnd;
            const peaksData = await sauce.hist.getPeaksForAthlete(this.athlete.id, this.type,
                periods, {direction, limit: 1, start, end});
            const valueFormatter = getPeaksValueFormatter(this.type);
            for (const x of peaksData) {
                peaks.push({
                    key: keyFormatter(x.period),
                    prettyValue: valueFormatter(x.value),
                    unit: getPeaksUnit(this.type),
                    activity: x.activity,
                });
            }
            return {
                athlete: this.athlete,
                collapsed: this.collapsed,
                type: this.type,
                sync: this.sync,
                activeDays: this.daily.filter(x => x.activities.length).length,
                tssAvg: this.daily.length ? sauce.data.sum(this.daily.map(x => x.tss)) / this.daily.length : 0,
                maxCTL: sauce.data.max(this.daily.map(x => x.ctl)),
                minTSB: sauce.data.min(this.daily.map(x => x.ctl - x.atl)),
                weeklyTime: sauce.data.avg(this.weekly.map(x => x.duration)),
                totalTime: sauce.data.sum(this.daily.map(x => x.duration)),
                missingTSS: this.missingTSS,
                peaks,
            };
        }

        async render() {
            if (this.pageView.athlete !== this.athlete) {
                await this.setAthlete(this.pageView.athlete);
            }
            await super.render();
        }

        async setAthlete(athlete) {
            this.athlete = athlete;
            const id = athlete && athlete.id;
            if (this.syncController) {
                this.syncController.removeEventListener('active', this.onSyncActive);
                this.syncController.removeEventListener('status', this.onSyncStatus);
                this.syncController.removeEventListener('error', this.onSyncError);
                this.syncController.removeEventListener('progress', this.onSyncProgress);
            }
            if (id) {
                this.syncController = getSyncController(id);
                this.syncController.addEventListener('active', this.onSyncActive);
                this.syncController.addEventListener('status', this.onSyncStatus);
                this.syncController.addEventListener('error', this.onSyncError);
                this.syncController.addEventListener('progress', this.onSyncProgress);
                this.sync = await this.syncController.getState();
                this.sync.counts = await sauce.hist.activityCounts(id);
            } else {
                this.syncController = null;
            }
        }

        async onRouterNav(_, period) {
            period = period && Number(period);
            if (period !== this.period) {
                this.period = period;
                await this.render();
            }
        }

        async onChangeAthlete(athlete) {
            await this.setAthlete(athlete);
        }

        async onTypeChange(ev) {
            this.type = ev.currentTarget.value;
            await sauce.storage.setPref(`perfSummarySectionType`, this.type);
            await this.render();
        }

        async _onSyncActive(ev) {
            if (ev.data) {
                this.syncError = null;
            }
            this.sync.active = ev.data;
            await this.render();
        }

        async _onSyncStatus(ev) {
            this.sync.status = ev.data;
            await this.render();
        }

        async _onSyncError(ev) {
            this.sync.error = ev.data.error;
            await this.render();
        }

        async _onSyncProgress(ev) {
            this.sync.counts = ev.data.counts;
            await this.render();
        }

        async onUpdatePeriod({activities, daily, start, end, metricData, metric}) {
            this.daily = daily;
            this.activities = activities;
            if (metric === 'week') {
                this.weekly = metricData;
            } else {
                this.weekly = aggregateActivitiesByWeek(daily, {isoWeekStart: true});
            }
            this.missingTSS = activities.filter(x => sauce.model.getActivityTSS(x) == null);
            this.periodStart = start;
            this.periodEnd = end;
            await this.render();
        }

        async onCollapserClick(ev) {
            await this.setCollapsed(ev.currentTarget.closest('section'), true);
        }

        async onExpanderClick(ev) {
            await this.setCollapsed(ev.currentTarget.closest('section'), false);
        }

        async onResultClick(ev) {
            const activity = await sauce.hist.getActivity(Number(ev.currentTarget.dataset.id));
            this.pageView.trigger('select-activities', [activity]);
        }

        async onMissingTSSClick(ev) {
            const bulkEditDialog = new BulkActivityEditDialog({
                activities: this.missingTSS,
                pageView: this.pageView
            });
            await bulkEditDialog.render();
            bulkEditDialog.show();
        }

        async onDblClickHeader(ev) {
            const section = ev.currentTarget.closest('section');
            await this.setCollapsed(section, !section.classList.contains('collapsed'));
        }

        async setCollapsed(section, en) {
            const id = section.dataset.id;
            const collapsed = en !== false;
            section.classList.toggle('collapsed', collapsed);
            this.collapsed[id] = collapsed;
            await sauce.storage.setPref(`perfSummarySectionCollapsed.${id}`, collapsed);
        }
    }


    class DetailsView extends view.SauceView {
        get events() {
            return {
                'click header a.collapser': 'onCollapserClick',
                'click .activity .edit-activity': 'onEditActivityClick',
                'click .btn.load-more.older': 'onLoadOlderClick',
                'click .btn.load-more.newer': 'onLoadNewerClick',
                'click .btn.load-more.recent': 'onLoadRecentClick',
            };
        }

        get tpl() {
            return 'performance-details.html';
        }

        async init({pageView}) {
            this.pageView = pageView;
            this.listenTo(pageView, 'change-athlete', async () => {
                this.activities = null;
                await this.render();
            });
            this.listenTo(pageView, 'select-activities', this.setActivities);
            await super.init();
        }

        async setActivities(activities, options={}) {
            this.activities = Array.from(activities);
            this.activities.sort((a, b) => b.ts - a.ts);
            await this.render();
            if (!options.noHighlight) {
                const expanded = this.$el.hasClass('expanded');
                await this.setExpanded();
                if (expanded) {
                    this.el.scrollIntoView({behavior: 'smooth'});
                } else {
                    this.$el.one('transitionend', () =>
                        this.el.scrollIntoView({behavior: 'smooth'}));
                }
            }
        }

        setElement(el, ...args) {
            const r = super.setElement(el, ...args);
            sauce.storage.getPref('perfDetailsAsideVisible').then(vis =>
                this.setExpanded(vis, {noSave: true}));
            return r;
        }

        async renderAttrs() {
            return {
                activities: this.activities,
                hasNewer: this.pageView.mainView.periodEnd < this.pageView.mainView.periodEndMax,
            };
        }

        async setExpanded(en, options={}) {
            const visible = en !== false;
            this.$el.toggleClass('expanded', visible);
            if (!options.noSave) {
                await sauce.storage.setPref('perfDetailsAsideVisible', visible);
            }
        }

        async onCollapserClick(ev) {
            await this.setExpanded(false);
        }

        async onEditActivityClick(ev) {
            const id = Number(ev.currentTarget.closest('[data-id]').dataset.id);
            let activity;
            for (const a of this.activities) {
                if (a.id === id) {
                    activity = a;
                    break;
                }
            }
            editActivityDialogXXX(activity, this.pageView);
        }

        async onLoadOlderClick(ev) {
            if (!this.activities.length) {
                return;
            }
            const oldest = this.activities[this.activities.length - 1];
            const more = await sauce.hist.getActivitySiblings(oldest.id, {direction: 'prev', limit: 1});
            await this.setActivities(this.activities.concat(more), {noHighlight: true});
        }

        async onLoadNewerClick(ev) {
            if (!this.activities.length) {
                return;
            }
            const newest = this.activities[0];
            const more = await sauce.hist.getActivitySiblings(newest.id, {direction: 'next', limit: 1});
            await this.setActivities(this.activities.concat(more), {noHighlight: true});
        }

        async onLoadRecentClick(ev) {
            const start = this.pageView.mainView.periodStart;
            const end = this.pageView.mainView.periodEnd;
            const activities = await sauce.hist.getActivitiesForAthlete(this.pageView.athlete.id,
                {start, end, limit: 10, direction: 'prev'});
            await this.setActivities(activities, {noHighlight: true});
        }
    }


    class BulkActivityEditDialog extends view.SauceView {
        get events() {
            return {
                'click .edit-activity': 'onEditActivityClick',
            };
        }

        get tpl() {
            return 'performance-bulkedit.html';
        }

        async init({activities, pageView}) {
            this.activities = activities;
            this.pageView = pageView;
            this.athletes = new Set(activities.map(x => x.athlete));
            this.icon = await sauce.images.asText('fa/list-duotone.svg');
            await super.init();
        }

        renderAttrs() {
            return {
                activities: this.activities,
            };
        }

        show() {
            sauce.modal({
                title: 'Edit Activities',
                el: this.$el,
                flex: true,
                width: '40em',
                icon: this.icon,
                dialogClass: 'sauce-edit-activities-dialog',
                extraButtons: [{
                    text: 'Save', // XXX localize
                    click: async ev => {
                        const updates = {};
                        for (const tr of this.$('table tbody tr')) {
                            updates[Number(tr.dataset.id)] = {
                                tssOverride: Number(tr.querySelector('input[name="tss_override"]').value) || null,
                                peaksExclude: tr.querySelector('input[name="peaks_exclude"]').checked,
                            };
                        }
                        ev.currentTarget.disabled = true;
                        ev.currentTarget.classList.add('sauce-loading');
                        try {
                            await sauce.hist.updateActivities(updates);
                            for (const id of Object.keys(updates)) {
                                await sauce.hist.invalidateActivitySyncState(Number(id), 'local',
                                    'training-load', {disableSync: true});
                                await sauce.hist.invalidateActivitySyncState(Number(id), 'local',
                                    'peaks', {disableSync: true});
                            }
                            await Promise.all([...this.athletes].map(x => sauce.hist.syncAthlete(x, {wait: true})));
                            await this.pageView.render();
                        } finally {
                            ev.currentTarget.classList.remove('sauce-loading');
                            ev.currentTarget.disabled = false;
                        }
                        this.$el.dialog('destroy');
                    }
                }]
            });
        }
    }


    class PeaksView extends view.SauceView {
        get events() {
            return {
                'change .peak-controls select[name="type"]': 'onTypeChange',
                'change .peak-controls select[name="time"]': 'onTimeChange',
                'change .peak-controls select[name="distance"]': 'onDistanceChange',
                'change .peak-controls select[name="limit"]': 'onLimitChange',
                'input .peak-controls input[name="include-all-athletes"]': 'onIncludeAllAthletesInput',
                'input .peak-controls input[name="include-all-dates"]': 'onIncludeAllDatesInput',
                'click .results table tbody tr': 'onResultClick',
                'click .edit-activity': 'onEditActivityClick',
                'pointerdown .resize-drag': 'onResizePointerDown',
            };
        }

        get tpl() {
            return 'performance-peaks.html';
        }

        async init({pageView}) {
            this.pageView = pageView;
            this.periodEnd = null;
            this.periodStart = null;
            this.athlete = pageView.athlete;
            this.athleteNameCache = new Map();
            this.listenTo(pageView, 'update-period', this.onUpdatePeriod);
            this.listenTo(pageView, 'change-athlete', this.setAthlete);
            const savedPrefs = await sauce.storage.getPref('peaksView') || {};
            this.prefs = {
                type: 'power',
                limit: 10,
                time: 300,
                distance: 10000,
                includeAllAthletes: false,
                includeAllDates: false,
                ...savedPrefs
            };
            await super.init();
        }

        renderAttrs() {
            return {
                prefs: this.prefs,
                peaks: this.peaks,
                mile: 1609.344,
                unit: getPeaksUnit(this.prefs.type),
                valueFormatter: getPeaksValueFormatter(this.prefs.type),
                athleteName: this.athleteName.bind(this),
            };
        }

        async render() {
            this.$el.addClass('loading');
            try {
                await this.loadPeaks();
                await super.render();
            } finally {
                this.$el.removeClass('loading');
            }
        }

        async athleteName(id) {
            if (!this.athleteNameCache.has(id)) {
                const athlete = await sauce.hist.getAthlete(id);
                this.athleteNameCache.set(id, athlete.name);
            }
            return this.athleteNameCache.get(id);
        }

        async savePrefs(updates) {
            Object.assign(this.prefs, updates);
            await sauce.storage.setPref('peaksView', this.prefs);
        }

        getWindow() {
            if (['pace', 'gap'].includes(this.prefs.type)) {
                return this.prefs.distance;
            } else {
                return this.prefs.time;
            }
        }

        async loadPeaks() {
            const options = {
                limit: this.prefs.limit,
                expandActivities: true,
                direction: getPeaksSortDirection(this.prefs.type),
            };
            if (!this.prefs.includeAllDates) {
                options.start = this.periodStart;
                options.end = this.periodEnd;
            }
            if (!this.prefs.includeAllAthletes) {
                this.peaks = await sauce.hist.getPeaksForAthlete(this.athlete.id, this.prefs.type,
                    this.getWindow(), options);
            } else {
                this.peaks = await sauce.hist.getPeaksFor(this.prefs.type,
                    this.getWindow(), options);
            }
        }

        async onUpdatePeriod({start, end}) {
            this.periodStart = start;
            this.periodEnd = end;
            await this.render();
        }

        async onTypeChange(ev) {
            await this.savePrefs({type: ev.currentTarget.value});
            await this.render();
        }

        async onTimeChange(ev) {
            await this.savePrefs({time: Number(ev.currentTarget.value)});
            await this.render();
        }

        async onDistanceChange(ev) {
            await this.savePrefs({distance: Number(ev.currentTarget.value)});
            await this.render();
        }

        async onLimitChange(ev) {
            await this.savePrefs({limit: Number(ev.currentTarget.value)});
            await this.render();
        }

        async onIncludeAllAthletesInput(ev) {
            await this.savePrefs({includeAllAthletes: ev.currentTarget.checked});
            await this.render();
        }

        async onIncludeAllDatesInput(ev) {
            await this.savePrefs({includeAllDates: ev.currentTarget.checked});
            await this.render();
        }

        async onResultClick(ev) {
            if (ev.target.closest('.results tr a, .results tr .btn')) {
                return;
            }
            const id = Number(ev.currentTarget.dataset.id);
            const activity = await sauce.hist.getActivity(id);
            this.pageView.trigger('select-activities', [activity]);
        }

        async onEditActivityClick(ev) {
            const id = Number(ev.currentTarget.closest('[data-id]').dataset.id);
            const activity = await sauce.hist.getActivity(id);
            editActivityDialogXXX(activity, this.pageView);
        }

        onResizePointerDown(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const origHeight = this.$el.height();
            const origPageY = ev.pageY;
            this.$el.height(origHeight);
            this.$el.addClass('fixed-height');
            const onDragDone = () => {
                removeEventListener('pointermove', onDrag);
                removeEventListener('pointerup', onDragDone);
                removeEventListener('pointercancel', onDragDone);
            };
            const onDrag = ev => {
                this.$el.height(origHeight + (ev.pageY - origPageY));
            };
            addEventListener('pointermove', onDrag);
            addEventListener('pointerup', onDragDone);
            addEventListener('pointercancel', onDragDone);
        }

        async setAthlete(athlete) {
            this.athlete = athlete;
            this.athleteNameCache.set(athlete.id, athlete.name);
            await this.render();
        }
    }


    class MainView extends view.SauceView {
        get events() {
            return {
                'change header.filters select[name="period"]': 'onPeriodChange',
                'click header.filters .btn.period': 'onPeriodShift',
                'click header.filters .btn.expand': 'onExpandClick',
                'click header.filters .btn.compress': 'onCompressClick',
                'click canvas': 'onChartClick',
                'dataVisibilityChange canvas': 'onDataVisibilityChange',
            };
        }

        get tpl() {
            return 'performance-main.html';
        }

        get periodEndMax() {
            const d = sauce.date.toLocaleDayDate(new Date());
            return d.getTime() + (86400 * 1000);
        }

        async init({pageView}) {
            this.peaksView = new PeaksView({pageView});
            this.pageView = pageView;
            this.period = await getCurrentPeriod();
            this.periodEnd = ns.router.filters.periodEnd || this.periodEndMax;
            this.periodStart = ns.router.filters.periodStart || this.periodEnd - (this.period * DAY);
            this.charts = {};
            this.athlete = pageView.athlete;
            this.listenTo(pageView, 'change-athlete', this.setAthlete);
            ns.router.on('route:onNav', this.onRouterNav.bind(this));
            this.dataVisibility = await sauce.storage.getPref('perfChartDataVisibility') || {};
            await super.init();
        }

        setElement(el, ...args) {
            const r = super.setElement(el, ...args);
            sauce.storage.getPref('perfMainViewExpanded').then(expanded =>
                this.toggleExpanded(!!expanded, {noSave: true, noAside: true}));
            return r;
        }

        async toggleExpanded(expanded, options={}) {
            this.$el.toggleClass('expanded', expanded);
            this.$el.prev('nav').toggleClass('compressed', expanded);
            if (!options.noAside) {
                await this.pageView.detailsView.setExpanded(!expanded);
            }
            if (!options.noSave) {
                await sauce.storage.setPref('perfMainViewExpanded', expanded);
            }
        }

        renderAttrs() {
            return {period: this.period};
        }

        async render() {
            await super.render();
            if (!this.athlete) {
                return;
            }
            // NOTE We don't call peaksView.render() because update() will trigger it.
            this.peaksView.setElement(this.$('.peaks-view'));
            this.charts.training = new ActivityTimeRangeChart('#training', this, {
                plugins: [chartOverUnderFillPlugin],
                options: {
                    scales: {
                        yAxes: [{
                            id: 'tss',
                            scaleLabel: {labelString: 'TSS'},
                            ticks: {min: 0, maxTicksLimit: 8},
                        }, {
                            id: 'tsb',
                            scaleLabel: {labelString: 'TSB'},
                            ticks: {maxTicksLimit: 8},
                            position: 'right',
                            gridLines: {display: false},
                        }]
                    },
                    tooltips: {
                        intersect: false,
                    },
                }
            });

            this.charts.activities = new ActivityTimeRangeChart('#activities', this, {
                options: {
                    useMetricData: true,
                    scales: {
                        yAxes: [{
                            id: 'tss',
                            scaleLabel: {labelString: 'TSS'}, // XXX localize
                            ticks: {min: 0, maxTicksLimit: 4},
                        }, {
                            id: 'duration',
                            position: 'right',
                            gridLines: {display: false},
                            scaleLabel: {labelString: 'Duration'}, // XXX localize
                            ticks: {
                                suggestedMax: 5 * 3600,
                                stepSize: 3600,
                                maxTicksLimit: 7,
                                callback: v => sauce.locale.human.duration(v, {maxPeriod: 3600})
                            }
                        }]
                    },
                }
            });

            const thousandFeet = 1609.344 / 5280 * 100;
            const stepSize = sauce.locale.elevationFormatter.unitSystem === 'imperial' ? thousandFeet : 1000;
            this.charts.elevation = new ActivityTimeRangeChart('#elevation', this, {
                options: {
                    scales: {
                        yAxes: [{
                            id: 'elevation',
                            scaleLabel: {labelString: 'Gain'}, // XXX localize
                            ticks: {
                                min: 0,
                                maxTicksLimit: 8,
                                stepSize,
                                callback: v => sauce.locale.human.elevation(v, {suffix: true}),
                            },
                        }]
                    },
                    tooltips: {
                        intersect: false,
                    },
                }
            });

            await this.update();
        }

        async update() {
            const start = this.periodStart;
            const end = this.periodEnd;
            const activities = await sauce.hist.getActivitiesForAthlete(this.athlete.id, {start, end});
            let atl = 0;
            let ctl = 0;
            if (activities.length) {
                ({atl, ctl} = await getSeedTrainingLoad(activities[0]));
            }
            this.daily = activitiesByDay(activities, start, end, atl, ctl);
            this.metric = this.period > 240 ? 'months' : this.period > 60 ? 'weeks' : 'days';
            if (this.metric === 'weeks') {
                this.metricData = aggregateActivitiesByWeek(this.daily, {isoWeekStart: true});
                this.$('.metric-display').text('Weekly'); // XXX localize
            } else if (this.metric === 'months') {
                this.metricData = aggregateActivitiesByMonth(this.daily);
                this.$('.metric-display').text('Monthly'); // XXX localize
            } else {
                this.$('.metric-display').text('Daily'); // XXX localize
                this.metricData = this.daily;
            }
            this.pageView.trigger('update-period', {
                start,
                end,
                metric: this.metric,
                activities,
                daily: this.daily,
                metricData: this.metricData,
            });
            const $start = this.$('header span.period.start');
            const $end = this.$('header span.period.end');
            $start.text(sauce.locale.human.date(start));
            const isEnd = end >= this.periodEndMax;
            this.$('.btn.period.next').toggleClass('hidden', isEnd);
            $end.text(isEnd ?
                new Intl.RelativeTimeFormat([], {numeric: 'auto'}).format(0, 'day') :
                sauce.locale.human.date(end));
            const lineWidth = this.period > 365 ? 0.5 : this.period > 90 ? 1 : 1.5;
            const maxCTLIndex = sauce.data.max(this.daily.map(x => x.ctl), {index: true});
            const minTSBIndex = sauce.data.min(this.daily.map(x => x.ctl - x.atl), {index: true});
            this.charts.training.data.datasets = [{
                id: 'ctl',
                label: 'CTL (Fitness)', // XXX Localize
                yAxisID: 'tss',
                borderWidth: lineWidth,
                backgroundColor: '#4c89d0e0',
                borderColor: '#2c69b0f0',
                fill: false,
                pointRadius: ctx => ctx.dataIndex === maxCTLIndex ? 3 : 0,
                tooltipFormat: x => Math.round(x).toLocaleString(),
                data: this.daily.map((a, i) => ({
                    x: a.date,
                    y: a.ctl,
                    showDataLabel: i === maxCTLIndex,
                }))
            }, {
                id: 'atl',
                label: 'ATL (Fatigue)', // XXX Localize
                yAxisID: 'tss',
                borderWidth: lineWidth,
                backgroundColor: '#ff3730e0',
                borderColor: '#f02720f0',
                fill: false,
                pointRadius: 0,
                tooltipFormat: x => Math.round(x).toLocaleString(),
                data: this.daily.map(a => ({
                    x: a.date,
                    y: a.atl,
                }))
            }, {
                id: 'tsb',
                label: 'TSB (Form)', // XXX Localize
                yAxisID: 'tsb',
                borderWidth: lineWidth,
                backgroundColor: '#bc714cc0',
                borderColor: '#0008',
                overUnder: true,
                overBackgroundColorMax: '#7fe78a',
                overBackgroundColorMin: '#bfe58a22',
                underBackgroundColorMin: '#d9940422',
                underBackgroundColorMax: '#bc0000ff',
                overBackgroundMax: 50,
                underBackgroundMin: -50,
                pointRadius: ctx => ctx.dataIndex === minTSBIndex ? 3 : 0,
                datalabels: {
                    align: 'start'
                },
                tooltipFormat: x => Math.round(x).toLocaleString(),
                data: this.daily.map((a, i) => ({
                    x: a.date,
                    y: a.ctl - a.atl,
                    showDataLabel: i === minTSBIndex,
                }))
            }];
            this.charts.training.update();

            this.charts.activities.data.datasets = [{
                id: 'tss',
                label: 'TSS',
                type: 'bar',
                backgroundColor: '#1d86cdd0',
                borderColor: '#0d76bdf0',
                yAxisID: 'tss',
                borderWidth: 1,
                barPercentage: 0.92,
                tooltipFormat: x => Math.round(x).toLocaleString(),
                data: this.metricData.map((a, i) => ({
                    x: a.date,
                    y: a.tss,
                })),
            }, {
                id: 'duration',
                label: 'Time', // XXX Localize
                type: 'bar',
                backgroundColor: '#fc7d0bd0',
                borderColor: '#dc5d00f0',
                borderWidth: 1,
                yAxisID: 'duration',
                barPercentage: 0.92,
                tooltipFormat: x => sauce.locale.human.duration(x, {maxPeriod: 3600}),
                data: this.metricData.map((a, i) => ({
                    x: a.date,
                    y: a.duration,
                })),
            }];
            this.charts.activities.update();

            let gain = 0;
            const gains = this.daily.map(x => {
                gain += x.altGain;
                return {x: x.date, y: gain};
            });
            this.charts.elevation.data.datasets = [{
                id: 'elevation',
                label: 'Elevation', // XXX Localize
                type: 'line',
                backgroundColor: '#8f8782e0',
                borderColor: '#6f6762f0',
                pointRadius: 0,
                yAxisID: 'elevation',
                borderWidth: lineWidth,
                tooltipFormat: x => sauce.locale.human.elevation(x, {suffix: true}),
                data: gains,
            }];
            this.charts.elevation.update();

        }

        async onExpandClick(ev) {
            await this.toggleExpanded(true);
        }

        async onCompressClick(ev) {
            await this.toggleExpanded(false);
        }

        async onChartClick(ev) {
            const chart = this.charts[ev.currentTarget.id];
            const box = chart.chartArea;
            if (ev.offsetX < box.left ||
                ev.offsetX > box.right ||
                ev.offsetY < box.top ||
                ev.offsetY > box.bottom) {
                return;
            }
            let elements;
            if (chart.options.tooltips.intersect === false) {
                elements = chart.getElementsAtXAxis(ev);
            } else {
                elements = chart.getElementsAtEvent(ev);
            }
            if (elements.length) {
                const idx = elements[0]._index;
                const slot = chart.options.useMetricData ? this.metricData[idx] : this.daily[idx];
                if (slot && slot.activities && slot.activities.length) {
                    this.pageView.trigger('select-activities', slot.activities);
                }
            }
        }

        async onRouterNav(_, period, startDay, endDay) {
            period = period && Number(period);
            const start = startDay && Number(startDay) * DAY;
            const end = endDay && Number(endDay) * DAY;
            let needRender;
            if (period !== this.period) {
                this.period = period || await getCurrentPeriod();
                needRender = true;
            }
            if (end !== this.periodEnd) {
                this.periodEnd = end || this.periodEndMax;
                needRender = true;
            }
            if (start !== this.periodStart) {
                this.periodStart = start || this.periodEnd - (DAY * this.period);
                needRender = true;
            }
            if (needRender) {
                await this.update();
            }
        }

        async onPeriodChange(ev) {
            this.period = Number(ev.currentTarget.value);
            this.periodStart = this.periodEnd - (DAY * this.period);
            this.updateNav();
            await this.update();
            await sauce.storage.setPref('perfMainViewDefaultPeriod', this.period);
        }

        async onPeriodShift(ev) {
            const next = ev.currentTarget.classList.contains('next');
            this.periodEnd = Math.min(this.periodEnd + this.period * DAY * (next ? 1 : -1),
                this.periodEndMax);
            this.periodStart = this.periodEnd - (this.period * DAY);
            this.updateNav();
            await this.update();
        }

        async onDataVisibilityChange(ev, data) {
            const chartId = ev.currentTarget.id;
            this.dataVisibility[`${chartId}-${data.id}`] = data.visible;
            await sauce.storage.setPref('perfChartDataVisibility', this.dataVisibility);
        }

        updateNav() {
            if (this.periodEnd === this.periodEndMax) {
                ns.router.setPeriod(this.athlete.id, this.period);
            } else {
                ns.router.setPeriod(this.athlete.id, this.period, this.periodStart, this.periodEnd);
            }
        }

        async setAthlete(athlete) {
            this.athlete = athlete;
            await this.update();
        }
    }


    class PageView extends view.SauceView {
        get events() {
            return {
                'change nav select[name=athlete]': 'onAthleteChange',
                'click .btn.sync-panel': 'onControlPanelClick',
            };
        }

        get tpl() {
            return 'performance.html';
        }

        async init({athletes}) {
            this.athletes = athletes;
            this.setAthlete(ns.router.filters.athleteId);
            this.summaryView = new SummaryView({pageView: this});
            this.mainView = new MainView({pageView: this});
            this.detailsView = new DetailsView({pageView: this});
            this.syncButtons = new Map();
            ns.router.on('route:onNav', this.onRouterNav.bind(this));
            await super.init();
        }

        renderAttrs() {
            return {
                athletes: Array.from(this.athletes.values()),
                athleteId: this.athlete && this.athlete.id,
            };
        }

        async render() {
            await super.render();
            this.$('nav .athlete select').after(await this.getSyncButton(this.athlete.id));
            this.summaryView.setElement(this.$('nav .summary'));
            this.mainView.setElement(this.$('main'));
            this.detailsView.setElement(this.$('aside.details'));
            await Promise.all([
                this.summaryView.render(),
                this.mainView.render(),
                this.detailsView.render(),
            ]);
        }

        setAthlete(athleteId) {
            let success = true;
            if (athleteId && this.athletes.has(athleteId)) {
                this.athlete = this.athletes.get(athleteId);
            } else {
                if (athleteId || Object.is(athleteId, NaN)) {
                    console.warn("Invalid athlete:", athleteId);
                    ns.router.setAthlete(undefined, {replace: true});
                    success = false;
                }
                this.athlete = this.athletes.get(currentUser) || this.athletes.values().next().value;
            }
            const $oldBtn = this.$('nav .athlete .sauce-sync-button');
            if ($oldBtn.length) {
                this.getSyncButton(this.athlete.id).then($btn => $oldBtn.before($btn).detach());
            }
            return success;
        }

        async getSyncButton(id) {
            if (!this.syncButtons.has(id)) {
                const $btn = await sauce.sync.createSyncButton(id, null, {noStatus: true});
                $btn.addClass('btn-icon-only btn-unstyled');
                this.syncButtons.set(id, $btn);
            }
            return this.syncButtons.get(id);
        }

        onAthleteChange(ev) {
            const id = Number(ev.currentTarget.value);
            if (this.setAthlete(id)) {
                ns.router.setAthlete(id);
            }
            this.trigger('change-athlete', this.athlete);
        }

        async onControlPanelClick(ev) {
            await sauce.sync.activitySyncDialog(this.athlete.id, getSyncController(this.athlete.id));
        }

        async onRouterNav(athleteId) {
            athleteId = athleteId && Number(athleteId);
            if (athleteId !== this.athlete.id) {
                this.setAthlete(athleteId);
                await this.render();
            }
        }
    }


    async function load() {
        const $page = jQuery('#error404');  // replace the 404 content
        $page.empty();
        $page.removeClass();  // removes all
        $page.attr('id', 'sauce-performance');
        const athletes = new Map((await sauce.hist.getEnabledAthletes()).map(x => [x.id, x]));
        const pageView = new PageView({athletes, el: $page});
        await pageView.render();
    }

    if (['interactive', 'complete'].indexOf(document.readyState) === -1) {
        addEventListener('DOMContentLoaded', () => load().catch(sauce.report.error));
    } else {
        load().catch(sauce.report.error);
    }
});
