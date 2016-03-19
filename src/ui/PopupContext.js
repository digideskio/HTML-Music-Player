"use strict";

import { slugTitle } from "util";
import Animator from "ui/Animator";
import Popup from "ui/Popup";

export default function PopupContext(opts) {
    opts = Object(opts);
    this.page = opts.page;
    this.globalEvents = opts.globalEvents;
    this.db = opts.db;
    this.scrollerContext = opts.scrollerContext;
    this.recognizerContext = opts.recognizerContext;
    this.dbValues = opts.dbValues;
    this.keyboardShortcuts = opts.keyboardShortcuts;
    this.rippler = opts.rippler;
    this.popupZIndex = opts.zIndex;

    this.shownPopups = [];
    this.blocker = this.page.NULL();
    this.animator = null;

    this.popupOpened = this.popupOpened.bind(this);
    this.popupClosed = this.popupClosed.bind(this);
    this.closePopups = this.closePopups.bind(this);

    this.blockerTapRecognizer = this.recognizerContext.createTapRecognizer(this.closePopups);
}

PopupContext.prototype.closePopups = function() {
    this.shownPopups.forEach(function(v) {
        v.close();
    });
};

PopupContext.prototype.showBlocker = function() {
    if (this.animator) {
        this.animator.stop();
        this.animator = null;
        this.blocker.remove();
    }

    this.blocker = this.page.createElement("div", {class: "popup-blocker"}).appendTo("body");
    this.blocker.addEventListener("click", this.closePopups);
    this.blockerTapRecognizer.recognizeBubbledOn(this.blocker);

    var animator = new Animator(this.blocker[0], this.page, {
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
};

PopupContext.prototype.hideBlocker = function() {
    if (!this.blocker.length) return;
    var animator = new Animator(this.blocker[0], this.page, {
        properties: [{
            name: "opacity",
            start: 55,
            end: 0,
            unit: "%",
            duration: 300
        }],
        interpolate: Animator.DECELERATE_CUBIC
    });

    this.animator = animator;

    animator.animate().then(function(wasCancelled) {
        if (!wasCancelled) {
            this.blockerTapRecognizer.unrecognizeBubbledOn(this.blocker);
            this.blocker.remove();
            this.blocker = this.page.NULL();
            this.animator = null;
        }
    }.bind(this));
};

PopupContext.prototype.popupOpened = function(popup) {
    this.keyboardShortcuts.disable();

    if (this.shownPopups.push(popup) === 1) {
        this.showBlocker();
    }
};

PopupContext.prototype.popupClosed = function(popup) {
    this.keyboardShortcuts.enable();
    this.db.set(this.toPreferenceKey(popup.title), {
        screenPosition: popup.getScreenPosition(),
        scrollPosition: popup.getScrollPosition()
    });

    var index = this.shownPopups.indexOf(popup);
    if (index >= 0) {
        this.shownPopups.splice(index, 1);
        if (this.shownPopups.length === 0) {
            this.hideBlocker();
        }
    }
};

PopupContext.prototype.toPreferenceKey = function(popupTitle) {
    return slugTitle(popupTitle) + "-popup-preferences";
};

PopupContext.prototype.makePopup = function(title, body, opener, footerButtons) {
    var self = this;
    var popup = new Popup({
        page: this.page,
        zIndex: this.popupZIndex,
        globalEvents: this.globalEvents,
        recognizerContext: this.recognizerContext,
        scrollerContext: this.scrollerContext,
        rippler: this.rippler,
        footerButtons: footerButtons,
        title: title,
        body: body,
        closer: '<span class="icon glyphicon glyphicon-remove"></span>',
        beforeTransitionIn: function($node) {
            $node.setFilter("");
            var animator = new Animator($node[0], self.page, {
                interpolate: Animator.DECELERATE_CUBIC,
                properties: [{
                    name: "opacity",
                    start: 0,
                    end: 100,
                    unit: "%",
                    persist: false
                }, {
                    name: "scale",
                    start: [0.95, 0.95],
                    end: [1, 1],
                    persist: false
                }]
            });

            return animator.animate(300);
        },

        beforeTransitionOut: function($node) {
            var animator = new Animator($node[0], self.page, {
                interpolate: Animator.DECELERATE_CUBIC,
                properties: [{
                    name: "opacity",
                    start: 100,
                    end: 0,
                    unit: "%",
                    persist: false
                }]
            });

            return animator.animate(300);
        },

        containerClass: "ui-text"
    });

    popup.on("open", this.popupOpened);
    popup.on("close", this.popupClosed);

    if (this.toPreferenceKey(popup.title) in self.dbValues) {
        var data = Object(self.dbValues[this.toPreferenceKey(popup.title)]);
        popup.setScreenPosition(data.screenPosition);
        popup.setScrollPosition(data.scrollPosition);
    }

    this.globalEvents.on("clear", popup.close.bind(popup));

    return popup;
};