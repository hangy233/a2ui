// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

part of 'parser.dart';

/// Reads one streamed direct JSON response.
///
/// Obtained from [DirectJsonParser.openStream].
///
/// Text outside a block is emitted as it arrives, less trailing whitespace
/// and any tail that could be the start of a tag, which wait for the next
/// chunk or for [close].
///
/// A message is emitted, and applied to [state], as soon as it reads and the
/// state accepts it, and again each time a later chunk changes it; each
/// [A2uiPart] carries the messages of one block that are new or changed. Only
/// `updateComponents` and `updateDataModel` are emitted while they grow. Any
/// other message, such as `createSurface`, `deleteSurface` or
/// `callRendererFunction`, is held until its object closes, and the messages
/// after it wait with it. When a block closes, the messages it holds are
/// applied in full and every surface they touched is checked in full. See
/// `conformance/agent/direct_json/response_streaming.yaml`.
///
/// The stream ends when [close] returns or when [feed] or [close] throws:
/// the response cannot be read further once part of it is rejected. The
/// messages already emitted stay in [state], since the renderer holds them,
/// and the components they added are marked checked
/// ([RendererState.markChecked]), so a later turn on the surface is not
/// required to make them reachable.
class DirectJsonResponseStream extends ResponseStream {
  DirectJsonResponseStream._(
    this._parser, {
    required bool wrapped,
    required this.state,
  }) : _wrapped = wrapped,
       _inBlock = !wrapped;

  final DirectJsonParser _parser;
  final bool _wrapped;

  @override
  final RendererState state;

  bool _closed = false;

  // Text outside blocks.
  String _held = '';
  bool _runStarted = false;
  String _heldSpace = '';

  // The open block.
  bool _inBlock;
  String _block = '';

  /// Finds the close tag of the open block as its text arrives.
  BlockScanner _scanner = BlockScanner(0);

  /// What the reads of the open block keep from one chunk to the next, for
  /// reads of the payload starting at [_readStart].
  PartialReadCache _readCache = PartialReadCache();
  int? _readStart;

  /// How many messages of the open block have closed and been applied.
  int _committed = 0;

  /// The messages of the open block applied so far, as JSON.
  final List<String> _applied = [];

  /// The surfaces the messages of the open block touched.
  final Set<String> _touched = {};

  /// Throws [A2uiParseError] if a block closes on text that is not JSON,
  /// [A2uiValidationError] if a message the block closes with is rejected,
  /// and what [DirectJsonParser.compile] throws for the catalogs, such as
  /// [A2uiCatalogError] for catalogs of different versions, as soon as a
  /// block holds part of a message.
  @override
  List<ResponsePart> feed(String chunk) {
    if (_closed) throw StateError('The response stream is closed.');
    // The surfaces of the messages already emitted in the open block, which
    // the state still holds if the chunk fails.
    final Set<String> emitted = {..._touched};
    try {
      // A chunk may apply messages and then fail, for example in a second
      // block, before its parts are returned. The transaction undoes them, so
      // the state holds only what was emitted.
      return state.transaction(() => _feed(chunk));
    } catch (_) {
      _fail(emitted);
      rethrow;
    }
  }

  @override
  List<ResponsePart> close() {
    if (_closed) return [];
    _closed = true;
    final parts = <ResponsePart>[];
    try {
      if (!_wrapped) {
        _finishBlock(parts, _block);
        return parts;
      }
      if (_inBlock) {
        throw A2uiParseError(
          'The response ended inside an $openTagText block, before its '
          '$closeTagText tag.',
        );
      }
    } catch (_) {
      _fail(_touched);
      rethrow;
    }
    if (_held.isNotEmpty) {
      _emitText(parts, _held);
      _held = '';
    }
    return parts;
  }

  /// Ends the stream after a failure, keeping what it emitted.
  ///
  /// The renderer holds the messages already emitted, which touched
  /// [surfaceIds], and so does the state. No message removes a component, so
  /// the components they added are marked checked: a later turn is not
  /// required to make them reachable.
  void _fail(Iterable<String> surfaceIds) {
    _closed = true;
    state.markChecked(surfaceIds);
  }

  List<ResponsePart> _feed(String chunk) {
    final parts = <ResponsePart>[];
    if (!_wrapped) {
      _block += chunk;
      _emitReady(parts, _block, _block.length);
      return parts;
    }
    String input = _held + chunk;
    _held = '';
    while (input.isNotEmpty) {
      if (_inBlock) {
        _block += input;
        input = '';
        final BlockScan scan = _scanner.scan(_block);
        final int? closeStart = scan.closeStart;
        if (closeStart == null) {
          _emitReady(parts, _block, scan.readableEnd);
          break;
        }
        input = _block.substring(
          closeTag.matchAsPrefix(_block, closeStart)!.end,
        );
        _finishBlock(parts, _block.substring(0, closeStart));
        continue;
      }
      final Match? open = openTag.firstMatch(input);
      if (open != null) {
        _emitText(parts, input.substring(0, open.start));
        _runStarted = false;
        _heldSpace = '';
        _inBlock = true;
        input = input.substring(open.end);
        continue;
      }
      final int hold = possibleTagStart(input);
      _emitText(parts, input.substring(0, hold));
      _held = input.substring(hold);
      input = '';
    }
    return parts;
  }

  /// Emits the text of a run, less leading whitespace at the start of the
  /// run and trailing whitespace, which is held until more text arrives.
  void _emitText(List<ResponsePart> parts, String text) {
    final String body = (_runStarted ? text : text.trimLeft()).trimRight();
    if (body.isEmpty) {
      if (_runStarted) _heldSpace += text;
      return;
    }
    final int start = _runStarted ? 0 : text.indexOf(body);
    parts.add(TextPart('$_heldSpace$body'));
    _heldSpace = text.substring(start + body.length);
    _runStarted = true;
  }

  /// Emits the messages of [block], the start of a block up to [end], that
  /// read and are accepted.
  void _emitReady(List<ResponsePart> parts, String block, int end) {
    final int? start = payloadStart(block, end);
    if (start == null) return;
    // The block only grows, so what earlier reads found holds while the
    // payload starts at the same place.
    if (start != _readStart) {
      _readStart = start;
      _readCache = PartialReadCache();
    }
    final bool wholeComponents = _parser._buffersComponents;
    final List<PartialMessage> items = readPartialMessages(
      block,
      _parser.progressiveKeys,
      wholeItemKeys: wholeComponents ? const {'components'} : const {},
      cache: _readCache,
      start: start,
      end: trailingFenceStart(block, start, end),
    );
    if (items.isEmpty) return;
    // Read outside the loop, so that catalogs it cannot read throw rather
    // than pass for a message that has not arrived in full.
    final MessageReader reader = _parser._readerFor();
    final ready = <AgentToRendererMessage>[];
    for (final (int index, (:Object? message, :bool closed)) in items.indexed) {
      if (index < _committed) continue;
      if (message is! Map<String, Object?>) break;
      // Only updateComponents and updateDataModel are emitted while they
      // grow. Any other message, such as createSurface, deleteSurface or
      // callRendererFunction, is held until its object closes, and the
      // messages after it wait with it.
      if (!closed && !_growsInPlace(message)) break;
      try {
        ready.addAll(_apply(index, reader.read(message)));
      } on A2uiError {
        // With whole components, each component of an update has closed, so
        // one that is rejected cannot become valid later.
        if (wholeComponents && _isWholeUpdate(message)) rethrow;
        // Not ready, and nothing after it is emitted ahead of it.
        break;
      }
      if (closed) _committed = index + 1;
    }
    if (ready.isNotEmpty) parts.add(A2uiPart(ready));
  }

  /// Applies the rest of a closed block and checks the surfaces it touched.
  ///
  /// [DirectJsonParser.compile] only reads the block. Each message is checked
  /// when the state applies it: the messages that closed while the block
  /// arrived were checked then, and the rest are checked here. The trees of
  /// the surfaces the block touched are checked last.
  ///
  /// The messages not emitted yet are emitted only if the checks pass, so a
  /// failed block leaves the state holding what was emitted.
  void _finishBlock(List<ResponsePart> parts, String block) {
    final List<AgentToRendererMessage> messages = _parser.compile(block);
    final List<AgentToRendererMessage> ready = state.transaction(() {
      final ready = <AgentToRendererMessage>[
        for (final (int index, AgentToRendererMessage message)
            in messages.indexed)
          if (index >= _committed) ..._apply(index, message),
      ];
      state.checkTopology(_touched);
      return ready;
    });
    if (ready.isNotEmpty) parts.add(A2uiPart(ready));
    _inBlock = false;
    _block = '';
    _scanner = BlockScanner(0);
    _readCache = PartialReadCache();
    _readStart = null;
    _committed = 0;
    _applied.clear();
    _touched.clear();
  }

  /// Applies [message], at [index] of the open block, if it changed.
  ///
  /// A newer version of a message holds everything the older one did, since
  /// components are replaced by id and a data model path is overwritten, so
  /// applying it over the older one is an update.
  ///
  /// Returns [message], if the renderer has not received it as it now stands.
  List<AgentToRendererMessage> _apply(
    int index,
    AgentToRendererMessage message,
  ) {
    final String json = jsonEncode(message.toJson());
    if (index < _applied.length && _applied[index] == json) return const [];
    _touched.addAll(state.apply([message]));
    if (index < _applied.length) {
      _applied[index] = json;
    } else {
      _applied.add(json);
    }
    return [message];
  }
}

/// Whether [envelope] is a message a renderer applies again as it grows, so
/// that it may be emitted before it closes.
bool _growsInPlace(Map<String, Object?> envelope) =>
    envelope.containsKey('updateComponents') ||
    envelope.containsKey('updateDataModel');

/// Whether [envelope] is an `updateComponents` with its version, its surface
/// and at least one component.
bool _isWholeUpdate(Map<String, Object?> envelope) =>
    envelope['version'] is String &&
    switch (envelope['updateComponents']) {
      {'surfaceId': String(), 'components': List(isNotEmpty: true)} => true,
      _ => false,
    };
