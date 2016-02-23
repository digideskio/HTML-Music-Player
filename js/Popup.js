"use strict";
const $ = require("../lib/jquery");
const Promise = require("../lib/bluebird.js");

const EventEmitter = require("events");
const util = require("./util");
const touch = require("./features").touch;
const domUtil = require("./DomUtil");
const Animator = require("./Animator");
const ContentScroller = require("./ContentScroller");

const shownPopups = [];
const NULL = $(null);
var blocker = NULL;
var anim = null;
function showBlocker() {
    if (anim) {
        anim.cancel();
        anim = null;
        domUtil.changeDom(function() {
            blocker.remove();
        });
    }

    function closePopups() {
        shownPopups.forEach(function(v) {
            v.close();
        });
    }

    domUtil.changeDom(function() {
        blocker = $("<div>", {class: "popup-blocker"}).appendTo("body");

        blocker.on("click", closePopups);

        if (touch) {
            blocker.on(domUtil.TOUCH_EVENTS, domUtil.tapHandler(closePopups));
        }

        var animator = new Animator(blocker[0], {
            properties: [{
                name: "opacity",
                start: 0,
                end: 55,
                unit: "%",
                duration: 300
            }],
            interpolate: Animator.DECELERATE_CUBIC
        });
        animator.animate();
    });
}

function hideBlocker() {
    var animator = new Animator(blocker[0], {
        properties: [{
            name: "opacity",
            start: 55,
            end: 0,
            unit: "%",
            duration: 300
        }],
        interpolate: Animator.DECELERATE_CUBIC
    });

    anim = animator.animate().then(function() {
        domUtil.changeDom(function() {
            blocker.remove();
            blocker = NULL;
            anim = null;
        });
    });
}

function Popup(opts) {
    EventEmitter.call(this);
    opts = Object(opts);

    this.transitionClass = opts.transitionClass || "";
    this.beforeTransitionIn = opts.beforeTransitionIn || $.noop;
    this.beforeTransitionOut = opts.beforeTransitionOut || $.noop;
    this.containerClass = util.combineClasses(opts.containerClass, "popup-container");
    this.headerClass = util.combineClasses(opts.headerClass, "popup-header");
    this.footerClass = util.combineClasses(opts.footerClass, "popup-footer");
    this.bodyClass = util.combineClasses(opts.bodyClass, "popup-body scrollbar-scrollarea");
    this.bodyContentClass = util.combineClasses(opts.bodyContentClass, "popup-body-content");
    this.closerContainerClass = util.combineClasses(opts.closerContainerClass, "popup-closer-container");
    this.scrollbarContainerClass = util.combineClasses(opts.scrollbarContainerClass, "scrollbar-container");
    this.scrollbarRailClass = util.combineClasses(opts.scrollbarRailClass, "scrollbar-rail");
    this.scrollbarKnobClass = util.combineClasses(opts.scrollbarKnobClass, "scrollbar-knob");


    this.body = util.toFunction(opts.body || "");
    this.title = util.toFunction(opts.title || "");
    this.closer = util.toFunction(opts.closer || "");
    this._x = -1;
    this._y = -1;
    this._rect = null;
    this._anchorDistanceX = -1;
    this._anchorDistanceY = -1;
    this._shown = false;
    this._dragging = false;
    this._frameId = -1;

    this._contentScroller = null;

    this._reLayout = this._reLayout.bind(this);
    this.position = this.position.bind(this);
    this.close = this.close.bind(this);
    this.headerMouseDowned = this.headerMouseDowned.bind(this);
    this.draggingEnd = this.draggingEnd.bind(this);
    this.mousemoved = this.mousemoved.bind(this);
    this.closerClicked = this.closerClicked.bind(this);
    this.closerClickedTouch = domUtil.tapHandler(this.closerClicked);
    this.headerMouseDownedTouch = domUtil.touchDownHandler(this.headerMouseDowned);
    this.touchDragHandler = domUtil.dragHandler(this.mousemoved, this.draggingEnd);

    $(window).on("resize", this._reLayout);

    this._popupDom = NULL;
    this._rect = null;
    this._viewPort = null;
}
util.inherits(Popup, EventEmitter);

Popup.prototype._deinitDom = function() {
    this.$().hide().removeClass(this.transitionClass).removeClass("initial");
};

Popup.prototype._initDom = function() {
    if (this._popupDom !== NULL) {
        this.$().show();
        return;
    }

    var ret = $("<div>", {
        class: this.containerClass,
    }).css({
        position: "absolute"
    }).appendTo("body");

    var headerText = $("<h2>").text(this.title() + "");
    var header = $("<div>", {class: this.headerClass});
    var footer = $("<div>", {class: this.footerClass});
    var body = $("<div>", {class: this.bodyClass});
    var bodyContent = $("<div>", {class: this.bodyContentClass}).html(this.body() + "");
    var closer = $("<div>", {class: this.closerContainerClass}).html(this.closer() + "");

    var scrollbar = $("<div>", {class: this.scrollbarContainerClass});
    var scrollbarRail = $("<div>", {class: this.scrollbarRailClass});
    var scrollbarKnob = $("<div>", {class: this.scrollbarKnobClass});

    headerText.appendTo(header);
    closer.appendTo(header);
    header.appendTo(ret);
    bodyContent.appendTo(body);
    scrollbar.appendTo(body);
    body.appendTo(ret);
    footer.appendTo(ret);

    scrollbarRail.appendTo(scrollbar);
    scrollbarKnob.appendTo(scrollbar);

    closer.on("click", this.closerClicked);
    header.on("mousedown", this.headerMouseDowned);

    if (touch) {
        closer.on(domUtil.TOUCH_EVENTS, this.closerClickedTouch);
        header.on(domUtil.TOUCH_EVENTS_NO_MOVE, this.headerMouseDownedTouch);
    }

    this._contentScroller = new ContentScroller(body, {
        scrollingX: false,
        snapping: false,
        zooming: false,
        paging: false,
        contentContainer: bodyContent,
        scrollbar: scrollbar,
        railSelector: "." + this.scrollbarRailClass,
        knobSelector: "." + this.scrollbarKnobClass
    });

    this._popupDom = ret;
};

Popup.prototype.destroy = function() {
    $(window).off("resize blur", this.draggingEnd);
    $(window).off("resize", this.position);
    util.documentHidden.removeListener("change", this.draggingEnd);
    this._deinitDom();
};

Popup.prototype.$ = function() {
    return this._popupDom;
};

Popup.prototype._getViewPort = function() {
    return {
        width: $(window).width(),
        height: $(window).height()
    };
};

Popup.prototype._reLayout = function() {
    if (!this._shown) return;
    var self = this;
    requestAnimationFrame(function() {
        self._viewPort = self._getViewPort();
        self.position();
        self._setMinimumNecessaryHeight();
        self._contentScroller.resize();
    });
};

Popup.prototype.position = function() {
    this._frameId = -1;
    if (!this._shown) return;
    var x = this._x;
    var y = this._y;
    var box = this._rect;
    var maxX = this._viewPort.width - box.width;
    var maxY = this._viewPort.height - box.height;

    if (x === -1) x = ((maxX + box.width) / 2) -  (box.width / 2);
    if (y === -1) y = ((maxY + box.height) / 2) -  (box.height / 2);

    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(0, Math.min(y, maxY));

    this._x = x;
    this._y = y;
    this._renderCssPosition();
};

Popup.prototype.refresh = function() {
    if (!this._shown) return;
    this.draggingEnd();
    this.position();
};

Popup.prototype.closerClicked = function() {
    this.close();
};

Popup.prototype._renderCssPosition = function() {
    if (this._dragging) {
        domUtil.setTransform(this.$()[0], "translate(" +
            (this._x /*- this._rect.width / 2*/) + "px, " +
            (this._y /*- this._rect.height / 2*/) + "px");
    } else {
        this.$().css({
            left: this._x,
            top: this._y
        });
    }
};

Popup.prototype._setMinimumNecessaryHeight = function() {
    var headerHeight = this.$().find(".popup-header").outerHeight(true);
    var footerHeight = this.$().find(".popup-footer").outerHeight(true);
    var contentHeight = this.$().find(".popup-body-content").outerHeight() + 2;
    this.$().css("height", Math.min(this._viewPort.height, contentHeight + footerHeight + headerHeight));
};

Popup.prototype.open = function() {
    if (this._shown) return;
    this._shown = true;
    shownPopups.push(this);

    try {
        if (shownPopups.length === 1) {
            showBlocker();
        }

        var firstOpen = this._popupDom === NULL;
        this._initDom();
        this.emit("open", this, firstOpen);
        this._rect = this.$()[0].getBoundingClientRect();
        this._viewPort = this._getViewPort();
        this.position();
        this._setMinimumNecessaryHeight();
        this._contentScroller.loadScrollTop(0);


        if (this.transitionClass) {
            var $node = this.$();
            $node[0].offsetHeight;
            $node.detach();
            $node.addClass(this.transitionClass + " initial");
            $node[0].offsetHeight;
            $node.appendTo("body");
            $node[0].offsetHeight;
            $node.removeClass("initial");
            $node[0].offsetHeight;
        }
        this.beforeTransitionIn(this.$());

    } catch (e) {
        this.close();
        throw e;
    }
};

Popup.prototype.mousemoved = function(e) {
    if (!this._shown) return;
    if (!domUtil.isTouchEvent(e) && e.which !== 1) {
        return this.draggingEnd();
    }
    this._x = Math.max(0, e.clientX - this._anchorDistanceX);
    this._y = Math.max(0, e.clientY - this._anchorDistanceY);
    if (this._frameId === -1) {
        this._frameId = requestAnimationFrame(this.position);
    }
};

Popup.prototype.headerMouseDowned = function(e, isClick, isTouch) {
    if (!this._shown || this._dragging || (domUtil.isTouchEvent(e) && e.isFirst === false)) return;
    if ($(e.target).closest("." + this.closerContainerClass).length > 0) return;
    this._dragging = true;
    this._anchorDistanceX = e.clientX - this._x;
    this._anchorDistanceY = e.clientY - this._y;
    this._rect = this._popupDom[0].getBoundingClientRect();
    this._viewPort = this._getViewPort();
    util.onCapture(document, "mouseup", this.draggingEnd);
    util.onCapture(document, "mousemove", this.mousemoved);
    if (touch) {
        util.onBubble(document, domUtil.TOUCH_EVENTS, this.touchDragHandler);
    }

    this.$().css({
        left: 0,
        top: 0
    });
    domUtil.setTransform(this.$()[0], "translate("+this._x+"px,"+this._y+"px)");
};

Popup.prototype.draggingEnd = function() {
    if (!this._dragging) return;
    this._dragging = false;
    util.offCapture(document, "mouseup", this.draggingEnd);
    util.offCapture(document, "mousemove", this.mousemoved);

    if (touch) {
        util.offBubble(document, domUtil.TOUCH_EVENTS, this.touchDragHandler);
    }

    this.$().css({
        left: this._x,
        top: this._y
    });
    domUtil.setTransform(this.$()[0], "none");
};

Popup.prototype.close = function() {
    if (!this._shown) return;
    this._shown = false;
    shownPopups.splice(shownPopups.indexOf(this), 1);

    this.emit("close", this);
    var self = this;
    Promise.resolve(this.beforeTransitionOut(this._popupDom)).finally(function() {
        self._deinitDom();
    });

    this.draggingEnd();

    if (shownPopups.length === 0) {
        hideBlocker();
    }
};

Popup.prototype.getPreferredPosition = function() {
    if (this._x === -1 || this._y === -1) return null;
    return {
        x: this._x,
        y: this._y
    };
};

Popup.prototype.setPreferredPosition = function(pos) {
    if (!pos) return;
    var x = pos.x;
    var y = pos.y;
    if (!isFinite(x) || !isFinite(y)) return;
    this._x = x;
    this._y = y;
    this.position();
};

module.exports = Popup;
