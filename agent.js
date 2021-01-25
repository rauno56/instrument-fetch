agent = (function () {
	const DEBUG = false;
	const log = DEBUG ? console.error : () => {};

	class Agent extends EventTarget {
		emitSpanStart(span) {
			this.dispatchEvent(new CustomEvent('span-start', { detail: span }));
		}
		emitSpanEnd(span) {
			this.dispatchEvent(new CustomEvent('span-end', { detail: span }));
		}
	}

	const agent = new Agent();

	const observer = new PerformanceObserver((list, observer) => {
		list.getEntries().forEach(handlePerformanceEntry);
	});
	observer.observe({
		type: 'resource',
		buffered: !true,
	});

	const handlePerformanceEntry = (entry) => {
		log('PO', entry.entryType, entry.name, entry);
		if (entry.entryType !== 'resource' || entry.initiatorType !== 'fetch') {
			return;
		}
		const span = unsentSpans.take(entry.name, entry);
		if (span) {
			span.resTimings = entry;
		}
	};

	const unsentSpans = (() => {
		const map = new Map();

		return {
			take: (url, entry) => {
				const { startTime: entryStart, fetchStart, responseEnd: entryEnd } = entry;
				const spans = map.get(url);

				if (!spans || spans.length === 0) {
					log('could not find span for', url);
					return null;
				}

				let found;
				for (let [key, span] of spans.entries()) {
					if (span.start <= entryStart && entryEnd <= span.end) {
						log('found a match', key, span);
						/*
							if the already-found span is longer, skip overwriting `found`, because `found`
							already matches somewhat better to the entry
						*/
						if (found && (found.span.end - found.span.start) >= (span.end - span.start)) {
							log('.. which is not better match');
							continue;
						}
						found = { key, span };
					}
				}

				if (found) {
					spans.splice(found.key, 1);
					return found.span;
				}

				log('falling back to poping', spans[spans.length - 1]);

				return spans.pop();
			},
			add: (span) => {
				log('adding span', span.url, span);

				if (map.has(span.url)) {
					const spans = map.get(span.url);
					spans.push(span);
				} else {
					map.set(span.url, [span]);
				}
			},
		};
	})();

	const parseArgs = (url, options) => {
		/*
			supports
			- fetch(url: string, options: object)
			- fetch(req: Request)
			returns { url: string, request: Request }
		*/
		if (url instanceof Request) {
			return {
				url: url.url,
				request: url,
			};
		}
		if (typeof url === 'string' && typeof options === 'object' || options === undefined) {
			return parseArgs(new Request(url, options || {}));
		}

		// Unsupported signature
		return {
			url,
			request: new Request(url),
		};
	};
	const PATCHED = Symbol.for('PATCHED');
	const originalFetch = window.fetch;
	/*
		Using `...args` to make absolutely sure that we pass arguments over
		to `originaFetch` unchanged.
	*/
	const patchedFetch = (...args) => {
		const resTimings = {};
		const span = {
			...parseArgs(...args),
			start: performance.now(),
			resTimings,
		};

		agent.emitSpanStart(span);
		unsentSpans.add(span);

		return originalFetch(...args)
			.then((result) => {
				span.status = result.status;
				span.result = result;
				return result;
			})
			.catch((err) => {
				span.error = err;
				return Promise.reject(err);
			})
			.finally(() => {
				span.end = performance.now();
				// Required for PerformanceObserver to finish it's (micro)task
				setTimeout(() => agent.emitSpanEnd(span));
			});
	};
	patchedFetch[PATCHED] = true;

	if (window.fetch && !window.fetch[PATCHED]) {
		window.fetch = patchedFetch;
	}

	return agent;
})();
