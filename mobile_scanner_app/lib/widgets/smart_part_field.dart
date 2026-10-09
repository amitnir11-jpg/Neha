import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

typedef PartSuggestion = Map<String, dynamic>;

class SmartPartField extends StatefulWidget {
  const SmartPartField(
      {super.key,
      required this.controller,
      required this.scopeKey,
      required this.search,
      required this.onSelected,
      this.onEdited});

  final TextEditingController controller;
  final String scopeKey;
  final Future<List<PartSuggestion>> Function(String query) search;
  final ValueChanged<PartSuggestion> onSelected;
  final VoidCallback? onEdited;

  @override
  State<SmartPartField> createState() => _SmartPartFieldState();
}

class _SmartPartFieldState extends State<SmartPartField> {
  final _focus = FocusNode();
  Timer? _timer;
  int _sequence = 0;
  int _active = -1;
  List<PartSuggestion> _parts = [];
  String _message = '';
  PartSuggestion? _selected;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (!_focus.hasFocus) {
        _timer?.cancel();
        _sequence++;
        if (mounted) {
          setState(() {
            _parts = [];
            _message = '';
          });
        }
      }
    });
  }

  @override
  void didUpdateWidget(covariant SmartPartField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scopeKey != widget.scopeKey) {
      _sequence++;
      _timer?.cancel();
      _parts = [];
      _message = '';
      _selected = null;
    }
  }

  @override
  void dispose() {
    _sequence++;
    _timer?.cancel();
    _focus.dispose();
    super.dispose();
  }

  void _changed(String value) {
    widget.onEdited?.call();
    _timer?.cancel();
    final sequence = ++_sequence;
    final query = value.trim().toUpperCase();
    final scope = widget.scopeKey;
    setState(() {
      _parts = [];
      _message = '';
      _selected = null;
      _active = -1;
    });
    if (query.isEmpty) return;
    _timer = Timer(const Duration(milliseconds: 200), () async {
      try {
        final parts = await widget.search(query);
        if (!mounted ||
            sequence != _sequence ||
            scope != widget.scopeKey ||
            !_focus.hasFocus) return;
        setState(() {
          _parts = parts.take(10).toList();
          _message = _parts.isEmpty ? 'No matching master parts' : '';
        });
      } catch (_) {
        if (!mounted ||
            sequence != _sequence ||
            scope != widget.scopeKey ||
            !_focus.hasFocus) return;
        setState(() {
          _parts = [];
          _message = 'Suggestions unavailable. Keep typing or retry.';
        });
      }
    });
  }

  void _choose(PartSuggestion part) {
    _sequence++;
    _timer?.cancel();
    final number = (part['partNumber'] ?? '').toString();
    widget.controller.value = TextEditingValue(
        text: number,
        selection: TextSelection.collapsed(offset: number.length));
    _focus.requestFocus();
    setState(() {
      _selected = part;
      _parts = [];
      _message = '';
      _active = -1;
    });
    widget.onSelected(part);
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent || _parts.isEmpty) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.arrowDown ||
        event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() {
        _active = event.logicalKey == LogicalKeyboardKey.arrowDown
            ? (_active + 1) % _parts.length
            : (_active <= 0 ? _parts.length - 1 : _active - 1);
      });
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter && _active >= 0) {
      _choose(_parts[_active]);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  String _details(PartSuggestion part) {
    final mrp = double.tryParse('${part['mrp']}') ?? 0;
    return [
      (part['partDescription'] ?? '').toString(),
      if (mrp > 0) 'MRP ₹${mrp.toStringAsFixed(2)}'
    ].where((text) => text.isNotEmpty).join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final height = math.max(80.0,
        math.min(230.0, (media.size.height - media.viewInsets.bottom) * .35));
    return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Focus(
              onKeyEvent: _key,
              child: TextField(
                controller: widget.controller,
                focusNode: _focus,
                autofocus: true,
                textCapitalization: TextCapitalization.characters,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: 'Part Number'),
                onChanged: _changed,
              )),
          if (_parts.isNotEmpty)
            ConstrainedBox(
                constraints: BoxConstraints(maxHeight: height),
                child: Material(
                  color: Theme.of(context).colorScheme.surface,
                  child: ListView.builder(
                      shrinkWrap: true,
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.manual,
                      itemCount: _parts.length,
                      itemBuilder: (context, index) => ListTile(
                            dense: true,
                            selected: index == _active,
                            title: Text('${_parts[index]['partNumber']}'),
                            subtitle: Text(_details(_parts[index]),
                                maxLines: 2, overflow: TextOverflow.ellipsis),
                            onTap: () => _choose(_parts[index]),
                          )),
                )),
          if (_message.isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 6), child: Text(_message)),
          if (_selected != null)
            Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(_details(_selected!))),
        ]);
  }
}
